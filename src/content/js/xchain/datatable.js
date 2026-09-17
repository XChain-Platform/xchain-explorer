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

// Handle initializing datatables with static data (pre-populated)
function initStaticDatatable(tableId, autoWidth=true){
    // Set number of records per page to display
    var sm   = localStorage,
        rec  = sm.getItem('records_per_page');
        page = (rec) ? parseInt(rec) : 10;
    // Detect any 'per page' changes and save to localStorage
    $('#' + tableId).on( 'length.dt', function ( e, settings, length ){
        sm.setItem('records_per_page',length);
    });
    // Initialized the datatable
    $('#' + tableId).dataTable({
        lengthMenu: [[10,20,30,40,50,60,70,80,90,100],[10,20,30,40,50,60,70,80,90,100]],
        pageLength: page,
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t><"search-options text-center border-bottom-0 p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: true,
        processing: true,
        autoWidth: autoWidth,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "_TOTAL_ results",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i><span id='" + tableId + "-paginate-info'></span>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function(o){
            var total  = o.fnRecordsTotal(),
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
        }
    });
}

// Load an action's rows into its datatable from the explorer API; query/type
// narrow the results to one address/block/etc when given.
// `opts` is the data-table component's seam (spec M2.2) and is absent on every
// hand-written call. It carries { columns, onDraw }: the resolved column config,
// and a callback run after each draw so the component can apply a theme's column
// order to the rows DataTables just built. The paging, offset-cursor and
// per-page-length behaviour below is untouched by it on purpose - that logic is
// the contract with the /explorer feeds' positional cursors, and the component
// layer was built around it rather than through it.
// coin is the chain ticker (BTC, LTC, DOGE, etc), action the feed name (address,
// credit, debit), query the value to narrow by (null in most cases) and type what
// that value is (address, block, token). For example:
//   loadDatatablesData('BTC', 'address', null, null) loads every address action;
//   loadDatatablesData('BTC', 'address', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', 'address')
//     loads the address actions for one address;
//   loadDatatablesData('BTC', 'address', '862623', 'block') loads those in one block.
function loadDatatablesData(coin, action, query, type, opts){
    // Handle initializing datatable object for this action
    if(!XC.datatables[action])
        XC.datatables[action] = {}
    if(!XC.datatables[action].last_start)
        XC.datatables[action].last_start = 0;
    // Setup short alias for tracking action specific datatable info
    let track = XC.datatables[action];
    // Set the name of the datatable to load data into
    let tableId = 'datatable-' + action;
    let request = xcDatatableNormalizeRequest(action, query, type);
    action = request.action;
    type = request.type;
    let endpoint = xcDatatableEndpoint(action);
    let url = xcDatatableUrl(coin, endpoint, action, query, type);
    // The contracts list is the one list page whose feed can answer a text search:
    // contract names and descriptions live in an indexed column pair (the contracts
    // table's FULLTEXT meta_search), so a term is answered by the FEED. Every other
    // list page keeps its box hidden, because with server-side paging a client-side
    // search filters only the ten rows already on screen, which reads as "no results"
    // for a term that has hundreds.
    let nameSearch = (action=='contract' && !request.emptySearch);
    let page = xcDatatablePageLength(tableId);
    let dtOptions = xcDatatableOptions(tableId, coin, action, type, track, opts, page, nameSearch, request.emptySearch);
    xcDatatableConfigureRequest(dtOptions, request.emptySearch, url, track, type);
    if(nameSearch) xcDatatableEnableNameSearch(tableId, url);
    $('#' + tableId).dataTable(dtOptions);
    if(nameSearch)
        $('#' + tableId + '_filter input').attr('placeholder', 'Search contract names');
}

function xcDatatableEndpoint(action){
    // Set the explorer API endpoint name based on the action
    let endpoint = null;
    if(['history','search'].includes(action)){
        endpoint = action;
    } else if(['address','batch','order_match','swap_match','cross_chain_match'].includes(action)){
        // These take '-es', not '-s'; the three *_match names would otherwise build
        // malformed endpoints ('cross_chain_matchs') whose ajax answers 404, which a
        // page renders as an empty table rather than as an error.
        endpoint = action + 'es';
    } else if(action=='market-history'){
        endpoint = 'market';
    } else if(action=='validator_capability'){
        // action+'s' would give the malformed 'validator_capabilitys'; the hub table
        // (and its /explorer feed) is 'validator_capabilities'.
        endpoint = 'validator_capabilities';
    } else if(action=='consensus_state'){
        // consensus_state is a mass noun (no plural 's'); its /explorer feed keeps the
        // singular table name.
        endpoint = 'consensus_state';
    } else {
        endpoint = action + 's';
    }
    return endpoint;
}
