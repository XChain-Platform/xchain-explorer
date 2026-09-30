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

function xcDatatableNormalizeRequest(action, query, type){
    // Handle searches a bit differently
    if(type=='search'){
        type   = action;
        action = 'search';
    }
    // A search feed has nothing to look up until the reader has typed something.
    // The url built below omits a null QUERY segment, which for a search yields
    // /{COIN}/explorer/search/{TYPE} - a 4-segment path the 5-segment
    // '/{COIN}/explorer/search/{QUERY}/{TYPE}' route cannot match, and which no
    // 3-segment list-all route covers either, so it 404s. A bare /search or
    // /{COIN}/search therefore fired all four of its feeds on arrival and rendered
    // the DataTables failure row in every tab before anyone had searched.
    // The empty state is a REQUEST the page should not make: below, this branch
    // gives the table a local empty dataset instead of an ajax source.
    let emptySearch = (action=='search' && (isNull(query) || String(query).trim()==''));
    // Automatically convert token searches on token page to subtoken
    if(type=='token' && action=='token')
        type = 'subtoken';
    // The Official Tokens tab loads the project's roster (project-registry.md)
    if(type=='token' && action=='project')
        type = 'roster';
    if(action=='market-history')
        type = 'history';
    return { action: action, type: type, emptySearch: emptySearch };
}

function xcDatatableUrl(coin, endpoint, action, query, type){
    // Set the explorer API url
    let url = '/' + coin + '/explorer/' + endpoint;
    if(query || action=='history' || action=='block')
        url += '/' + xcEncodePathSegments(query);
    if(type)
        url += '/' + type;
    return url;
}

function xcDatatablePageLength(tableId){
    // Set number of records per page to display
    var sm   = localStorage,
        rec  = sm.getItem('records_per_page');
        page = (rec) ? parseInt(rec) : 10;
    // Detect any 'per page' changes and save to localStorage
    $('#' + tableId).on( 'length.dt', function ( e, settings, length ){
        sm.setItem('records_per_page',length);
    });
    return page;
}

function xcDatatableDrawPage(tableId, track, o){
    var total  = o._iRecordsTotal,
        length = o._iDisplayLength,
        stop   = o._iDisplayStart + length,
        page   = stop / length,
        pages  = total / length;
    if(pages > parseInt(pages))
        pages = parseInt(pages) + 1;
    // Add 'Page X of Y' in between previous/next buttons
    var page_status = $('#' + tableId + '_wrapper .page-status');
    if(page_status.length==0){
        $('#' + tableId + '_wrapper .paginate_button.previous').after('<span class="page-status">page status here</span>');
        page_status = $('#' + tableId + '_wrapper .page-status');
    }
    page_status.text('Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0'));
    // A table with no ajax source (the no-query search state) carries no
    // o.json at all, so every read below has to go through this alias or the
    // draw callback throws a TypeError on the first paint.
    var json = (o && o.json) ? o.json : null;
    // Track first and last shown action_index (used for offset tracking)
    if(json && json.data && json.data.length){
        var first = json.data[0],
            last  = json.data[json.data.length-1];
        track['offset_first'] = first[first.length-1];
        track['offset_last']  = last[last.length-1];
    } else {
        track['offset_first'] = 0;
        track['offset_last']  = 0;
    }
    // Save the start so we can determine direction when user clicks (prev/next)
    track['last_start'] = o._iDisplayStart;
    // Save total, so we can pass back in API requests (used to calculate how many records to display on 'last' page)
    track['total'] = (json) ? json.recordsTotal : 0;
}

function xcDatatableHideColumns(action, type){
    // Handle hiding fields with unnecessary info (address / token)
    if(!['address','token'].includes(type)) return;
    // Set the index for the field to hide
    let ids = [];
    if(type=='address')
        ids.push(3);
    if(type=='token'){
        if(action=='sleep')
            ids.push(5);
        else
            ids.push(4);
    }
    $('[id^="datatable-"]').each(function(){
        let el  = $(this);
        let table = String(el.attr('id')).replace('datatable-','');
        if(table==action){
            let hide = true;
            if(type=='address' && ['balance','token', 'dispense', 'sweep'].includes(table))
                hide = false;
            if(type=='token' && ['holder','dispense','dispenser'].includes(table))
                hide = false;
            if(table=='history')
                hide = false;
            if(table=='market')
                hide = false;
            if(hide){
                let tr = el.find('tr');
                for(let idx of ids){
                    tr.find('th:eq(' + idx + ')').hide();
                    tr.find('td:eq(' + idx + ')').hide();
                }
            }
        }
    });
}

function xcDatatableDrawCallback(tableId, action, type, track, opts, o){
    xcDatatableDrawPage(tableId, track, o);
    xcDatatableHideColumns(action, type);
    // Last, so the component sees the rows in their finished state: the
    // per-type hiding above is part of what a permutation has to agree
    // with, and running the hook before it would reorder cells the code
    // above then hides by index.
    if(opts && typeof opts.onDraw === 'function')
        opts.onDraw(tableId, o);
}

function xcDatatableCreateRow(row, data, idx, coin, action, type){
            // Parse the row data into the standard fields
            let action_index = data[data.length-1];
            let status       = data[data.length-2];
            let count        = data[0];
            let block_index  = data[1];
            let timestamp    = data[2];
            let source       = data[3];
            // Define the various numeral formats used
            let fmtInteger   = '0,0';
            let fmtCurrency  = '0,0.00';
            let fmtCoin      = '0,0.00000000';
            // Define the link to the action_index
            let action_link  = formatLink('/' + coin + '/action/' + action_index, 'view', null, true);
            let block_link   = formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0'));
            let source_link  = formatLink('/' + coin + '/address/' + source, source);
            // Set row to display to red or green based on status
            if(!['balance','credit','debit','token','project','block','fee','holder','search','market','market-history','slash_event','capability_slash_event','oracle_price','reward','cross_chain_match','cross_chain_settlement','validator_capability','capability_snapshot','governance_proposal','governance_vote','peer','consensus_state','config','telemetry_ping','checkpoint','commitment','anchor_reward_attestation','reorg','slash_proposal','attest_validator_stat','price_snapshot','emission','coinpay_obligation','action'].includes(action)){
                var cls = (status==1) ? 'bg-green' : 'bg-red';
                // For escrow, green=credit, red=debit
                if(action=='escrow')
                    cls = (String(data[5]).substring(0,1)=='-') ? 'bg-red' : 'bg-green';
                $(row).addClass(cls);
            }
            // Display the first few fields
            $('td', row).eq(0).html(numeral(count).format('0,0'));
            $('td', row).eq(1).html(block_link);
            $('td', row).eq(2).html(formatLivestamp(timestamp));
            $('td', row).eq(3).html(source_link);
    let context = { row, data, idx, coin, action, type, action_index, status, count,
        block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin,
        action_link, block_link, source_link };
    let handler = xcDatatableRowHandlers[action];
    if(handler) handler(context);
}

function xcDatatableOptions(tableId, coin, action, type, track, opts, page, nameSearch, emptySearch){
    // Load data into the datatable. The config is assembled in a variable rather
    // than passed as a literal so the no-query search state can swap the feed for a
    // local empty dataset without duplicating the rest of it.
    return {
        lengthMenu: [[10,20,30,40,50,60,70,80,90,100],[10,20,30,40,50,60,70,80,90,100]],
        pageLength: page,
        // 'f' (the filter box) is rendered only where a term can actually be answered;
        // DataTables draws no control for an option it is not given a slot for.
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>'
            + (nameSearch ? '<"xc-name-filter float-end me-2"f>' : '')
            + '><"search-results"t><"search-options text-center border-bottom-0 p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>>',
        pagingType: "full",
        // Server-side paging is meaningless without a feed to page against.
        serverSide: !emptySearch,
        searching: nameSearch,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "_TOTAL_ results",
            // info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i><span id='" + tableId + "-paginate-info'></span>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function(o){ xcDatatableDrawCallback(tableId, action, type, track, opts, o); },
        createdRow: function(row, data, idx){ xcDatatableCreateRow(row, data, idx, coin, action, type); }
    };
}

function xcDatatableAjax(url, track, type){
    return {
        url: url,
        data: function(data){
            // Pass action and offset with request
            var action = null,
                offset = null;
            if(data.start==0){
                action = 'first';
            } else if(data.start > (track['last_start'] + data.length)){
                action = 'last';
            } else if(data.start >= track['last_start']){
                action = 'next';
                offset = track['offset_last'];
            } else {
                action = 'prev';
                offset = track['offset_first'];
            }
            // Pass action and offset forward
            data.action = action;
            data.offset = offset;
            // pass total back to server (lets it quickly calculate how many records to display on 'last' page)
            data.total =  track['total'];
            if(['subtoken','roster'].includes(type))
                data.sortorder = 'ASC';
            // Cleanup the request so we only send what we need
            delete data.columns;
            delete data.order;
            delete data.search;
            delete data.draw;
        }
    };
}

function xcDatatableConfigureRequest(dtOptions, emptySearch, url, track, type){
    if(emptySearch){
        // No feed, no request: DataTables paints its own zeroRecords row from a
        // local empty dataset, so a bare search page renders an empty-but-correct
        // table in every tab and touches the network zero times. "No records found"
        // would be the wrong words here - nothing was looked up - so this state
        // says what the reader has to do instead.
        dtOptions.data = [];
        dtOptions.language.zeroRecords = 'Enter a search term above to see results';
    } else {
        dtOptions.ajax = xcDatatableAjax(url, track, type);
    }
}

function xcDatatableEnableNameSearch(tableId, baseUrl){
    // The search box asks the feed a QUESTION, it does not filter what is on screen.
    // These feeds take their term as a path segment (/explorer/contracts/<term>/name),
    // never as a request parameter, so the term is turned into a url here. preXhr
    // fires before DataTables extends its base ajax config with settings.ajax, so
    // rewriting .url on the live object retargets THIS request: one fetch per term,
    // not the term's own fetch plus a reload.
    $('#' + tableId).on('preXhr.dt', function(e, settings, params){
        let term = (params && params.search && !isNull(params.search.value))
            ? String(params.search.value).trim() : '';
        // The same 3-character floor the server holds the FULLTEXT term to
        // (innodb_ft_min_token_size): a shorter term matches nothing, so show the
        // unfiltered list rather than an empty page the reader cannot explain.
        settings.ajax.url = (term.length >= 3)
            ? baseUrl + '/' + encodeURIComponent(term) + '/name'
            : baseUrl;
    });
}
