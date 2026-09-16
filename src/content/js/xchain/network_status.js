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
 * network_status.js
 *
 * Custom javascript for xchain explorer
 */

// Deliberately not moment(): the banner must not depend on a script that
// loads after this one, and a reader stuck on a delayed page does not need
// precision past the largest unit.
function formatTipAge(seconds){
    if(isNull(seconds)) return null;
    let s = Number(seconds);
    if(!isFinite(s) || s < 0) return null;
    if(s < 60)     return 'under a minute';
    if(s < 3600)   { let m = Math.round(s / 60);    return m + ' minute' + (m===1 ? '' : 's'); }
    if(s < 86400)  { let h = Math.round(s / 3600);  return h + ' hour'   + (h===1 ? '' : 's'); }
    let d = Math.round(s / 86400); return d + ' day' + (d===1 ? '' : 's');
}

// The sentence the freshness banner shows for a coin, built from the /status
// body, or null when the coin is current (or not measured by this instance).
// Reads the same per-coin maps /status already publishes: `stale` is the
// verdict, last_block / tip_age_seconds say where the data stops, and
// replica_halted / indexer_state / indexer_wait_clears_at say WHY, so the
// reader is told the specific thing that is happening rather than a generic
// "degraded". Every page keeps rendering from the database underneath this;
// the banner is the only thing that changes while a coin is behind.
function freshnessBannerText(status, coin){
    if(!status || !status.stale || !status.stale[coin]) return null;
    let block  = (status.last_block          && !isNull(status.last_block[coin]))          ? status.last_block[coin]          : null;
    let age    = (status.tip_age_seconds     && !isNull(status.tip_age_seconds[coin]))     ? status.tip_age_seconds[coin]     : null;
    let halted = (status.replica_halted      && status.replica_halted[coin] === true);
    let state  = (status.indexer_state       && !isNull(status.indexer_state[coin]))       ? status.indexer_state[coin]       : null;
    let clears = (status.indexer_wait_clears_at && !isNull(status.indexer_wait_clears_at[coin])) ? status.indexer_wait_clears_at[coin] : null;
    let text   = '';
    if(block !== null){
        text += 'The last confirmed block was #' + String(block).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        let ago = formatTipAge(age);
        if(ago) text += ', about ' + ago + ' ago';
        text += '. ';
    }
    if(halted){
        text += 'Indexing is paused while this server is repaired; everything up to that block is shown and will update when indexing resumes.';
    } else if(state === 'future_block_wait' && clears){
        let wait = formatTipAge((Date.parse(clears) - Date.now()) / 1000);
        text += 'The next block is dated ahead of this server\'s clock; indexing resumes ' + (wait ? 'in about ' + wait : 'shortly') + '.';
    } else {
        text += 'The indexer is catching up; everything up to that block is shown and will update shortly.';
    }
    return text;
}

// Show or hide the freshness banner for the current coin from XC.status, and
// while the coin is behind, re-read /status on a short cadence so the banner
// clears itself the moment the coin catches up. The ordinary status refresh is
// five minutes (getExplorerStatusInfo's localStorage window), which is the
// wrong cadence for a notice whose whole job is to go away.
function updateFreshnessBanner(){
    if(typeof $ === 'undefined' || !XC || isNull(XC.coin)) return;
    let text = freshnessBannerText(XC.status, XC.coin);
    if(text){
        $('#freshness-banner-text').text(text);
        $('#freshness-banner').show();
        if(!XC.freshnessRecheckTimer)
            XC.freshnessRecheckTimer = setTimeout(function(){
                XC.freshnessRecheckTimer = null;
                getExplorerStatusInfo(null, true);
            }, XC.freshnessRecheckMs || 60000);
    } else {
        $('#freshness-banner').hide();
    }
}

// Handle updating coin network information and passing it to callback function for processing
// NOTE: This information is cached in localStorage and updated every 5 minutes as
function getCoinNetworkInfo(callback, force){
    let name   = XC.coin + '-network-info',
        info   = ls.getItem(name),
        json   = (info) ? JSON.parse(info) : false;
        last   = (json && json.timestamp) ? json.timestamp : 0,
        ms     = 300000, // 5 minutes
        update = ((parseInt(last) + ms) <= Date.now()||force) ? true : false;
    if(XC.status && isNull(XC.status.available[XC.coin])){
        networkStatus_recheckUnavailable(callback, force);
        return;
    }
    // Set the coin price from the last known price
    if(json && json.coin && json.coin.price && json.coin.price.usd)
        XC.coin_price = json.coin.price.usd;
    // Define callback function to handle processing data once we have it
    let cb = function(json){
        if(json){
            // Set the current USD price for COIN
            XC.coin_price = json.coin.price.usd;
            // Handle processing the callback if we have one
            if(typeof callback=='function')
                callback(json);
        }
    }
    // Do not update if we already have a pending request
    if(XC.pendingNetworkInfoRequest)
        update = false;
    if(update){
        // Set flag to indicate we have a pending request to prevent duplicate requests
        XC.pendingNetworkInfoRequest = true;
        if(XC.debug)
            XCLogger.log('Updating network information...');
        // Request updated network information and store the response in localStorage
        loadApiData(XC.coin, 'network', null, null, function(json){
            XC.pendingNetworkInfoRequest = false;
            json.timestamp = Date.now();
            ls.setItem(name,JSON.stringify(json));
            cb(json);
        }, function(){
            // The request failed (a 503 while the coin's tip is stale, or a transport
            // error). Clear the in-flight flag so a later call can retry, and answer the
            // caller with the last body we did store rather than never answering: a
            // failed refresh must not be indistinguishable from a page that is still
            // loading. Nothing is written to localStorage, so the next call re-requests.
            XC.pendingNetworkInfoRequest = false;
            cb(json);
        });
    } else {
        // If we have a pending Network request, try again in 1000ms
        if(XC.pendingNetworkInfoRequest){
            setTimeout(function(){
                getCoinNetworkInfo(callback);
            }, 1000);
        } else {
            cb(json);
        }
    }
}

// Recheck status while the selected coin remains unavailable.
function networkStatus_recheckUnavailable(callback, force){
    // A coin drops out of XC.status.available only on an explorer running with
    // EXPLORER_STALE_FAIL_CLOSED=1, where a stale tip also answers 503
    // COIN_DATA_STALE on the data routes; by default a stale coin stays listed and
    // is served with a freshness marker (see updateFreshnessBanner). XC.status is
    // itself served from localStorage for 5 minutes, so simply returning here
    // dropped the caller's render callback and left the summary counters and the
    // Network Information panel at their markup defaults (0 / blank) for the rest
    // of that window - with no /api/* request on the page load that showed the
    // zeros - long after the coin was serving live data again. Re-read the status
    // instead, and come back to this coin the moment it is listed again.
    // One recheck in flight at a time: the forced status refresh below calls back
    // into this function itself, and a per-caller loop would multiply the polling.
    if(!XC.pendingNetworkInfoRecheck){
        XC.pendingNetworkInfoRecheck = true;
        getExplorerStatusInfo(function(){
            XC.pendingNetworkInfoRecheck = false;
            if(XC.status && isNull(XC.status.available[XC.coin]))
                // Still stale. Keep the page self-healing on a slow poll rather than
                // waiting for the operator's user to reload it.
                setTimeout(function(){ getCoinNetworkInfo(callback, force); }, XC.networkRecheckMs || 15000);
            else
                getCoinNetworkInfo(callback, force);
        }, true);
    }
}

// Handle updating xchain-explorer configuration information and passing it to callback function for processing
// NOTE: This information is cached in localStorage and updated every 5 minutes
function getExplorerStatusInfo(callback, force){
    let name   = 'xchain-explorer-status-info',
        info   = ls.getItem(name),
        json   = (info) ? JSON.parse(info) : false;
        last   = (json && json.timestamp) ? json.timestamp : 0,
        ms     = 300000, // 5 minutes
        update = ((parseInt(last) + ms) <= Date.now()||force) ? true : false;
    // Set the coin price from the last known price
    if(json){
        XC.status = json;
        if(typeof updateFreshnessBanner === 'function')
            updateFreshnessBanner();
    }
    // Define callback function to handle processing data once we have it
    let cb = function(json){
        networkStatus_applyStatus(json, callback);
    }
    // Do not update if we already have a pending request
    if(XC.pendingStatusInfoRequest)
        update = false;
    if(update){
        // Set flag to indicate we have a pending request to prevent duplicate requests
        XC.pendingStatusInfoRequest = true;
        if(XC.debug)
            XCLogger.log('Updating status information...');
        // Request updated status information and store the response in localStorage
        loadApiData(XC.coin, 'status', null, null, function(json){
            XC.pendingStatusInfoRequest = false;
            json.timestamp = Date.now();
            ls.setItem(name,JSON.stringify(json));
            cb(json);
        }, function(){
            // Same contract as the network fetch above: clear the in-flight flag and
            // always answer the caller, here with the last status we stored. cb() only
            // fires for a truthy body, so answer an absent one directly - a caller
            // waiting on this (getCoinNetworkInfo's stale-coin recheck) must not be
            // left holding a flag no response will ever clear.
            XC.pendingStatusInfoRequest = false;
            if(json)
                cb(json);
            else if(typeof callback=='function')
                callback(null);
        });
    } else {
        // If we have a pending Network request, try again in 1000ms
        if(XC.pendingStatusInfoRequest){
            setTimeout(function(){
                getExplorerStatusInfo(callback);
            }, 1000);
        } else {
            cb(json);
        }
    }
}

// Apply a status response and notify its waiting caller.
function networkStatus_applyStatus(json, callback){
    if(json){
        // Update the xchain-explorer status
        XC.status = json;
        // Show, refresh or clear the delayed-data banner for this coin
        if(typeof updateFreshnessBanner === 'function')
            updateFreshnessBanner();
        // Get basic information on the COIN network
        getCoinNetworkInfo();
        // Handle processing the callback if we have one
        if(typeof callback=='function')
            callback(json);
    }
}


// Handle setting up listeners on action dropdowns to load content when clicked 
function setupActionListeners(){
    for(let action of XC.panels){
        $('#tab-dropdown-' + action).click(function(){
            let load = true;
            // Hide all tab panels and only show the active one
            $('.tab-pane').removeClass('active show');
            $('#tab-pane-' + action).addClass('active show');
            // Update datatable header to show correct icon and text for the data
            var icon = $(this).find('i').attr('class'),
                text = $(this).text();
            // Skip loading data in certain cases (like actions where all data already exists in the API call)
            if(['action','tx_hash','tx_index'].includes(XC.type)){
                load = false;
                if(action=='info'){
                    icon = 'fa fa-info-circle';
                    text = 'Action Details';
                }
            }
            $('#datatable-header-icon').removeClass().addClass(icon);
            $('#datatable-header-text').text(text);
            // Handle initilizing the datatable for this action
            if(!XC.datatables[action] && load){
                XC.datatables[action] = {};
                if(XC.debug)
                    XCLogger.log('loading ' + action + ' data...');
                // Set flag to indicate the tab has been loaded already
                let query  = (isNull(XC.query)) ? null : XC.query,
                    type   = (isNull(XC.type)) ? null : XC.type;
                // Set history to recent type if typ eis not already set
                if(action=='history' && isNull(type))
                    type   = 'recent';
                // Load data for the given action into the datatable
                loadDatatablesData(XC.coin, action, query, type);
            }
        });
    }
    // Handle setting up listeners on chart dropdowns 
    if(!isNull(XC.charts)){
        for(let chart of XC.charts){
            $('#chart-dropdown-' + chart).click(function(){
                loadMarketChart(chart);
            });
        }
    }
}

// Handle setting up collapsible headers and restoring the last known state
function setupCollapsibleHeaders(){
    // Detect header collapse clicks and change icon
    $('.collapse-header').click(function(){ toggleCollapseContent($(this).attr('id')); });
    // Restore collapsed header states
    $('.collapse-header').each(function(){ toggleCollapseContent($(this).attr('id'), true); });
}

// Basic Calculator (BC) math functions: amount math done in full precision.
// Coerce to a full-precision mathjs bignumber, NOT a JS double, matching the
// SDK/indexer canonical bcnum: neither this nor the bc* helpers below may re-funnel a
// result through parseFloat, which truncates past ~16 digits into scientific notation.
// Non-numeric, NaN and Infinity yield bignumber(0) rather than throwing.
function bcnum(num){
    let str = String(num).trim();
    if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !isNumeric(num))
        return math.bignumber(0);
    return math.bignumber(str);
}

// Handle returning a number to a given decimal point precision
function bcformat(num, decimals){
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(bcnum(num),{notation: 'fixed', precision: d});
}

// Handle subtracting 2 big numbers (returns a fixed-notation string, full precision)
function bcsub(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.subtract(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle adding 2 big numbers (returns a fixed-notation string, full precision)
function bcadd(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.add(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle multiplying 2 big numbers (returns a fixed-notation string, full precision)
function bcmul(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.multiply(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle dividing 2 big numbers (returns a fixed-notation string, full precision)
function bcdiv(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.divide(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}
