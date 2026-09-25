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
        type     = 'history';
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
    // Set the explorer API url
    let url = '/' + coin + '/explorer/' + endpoint;
    if(query || action=='history' || action=='block')
        url += '/' + query;
    if(type)
        url += '/' + type;
    // The contracts list is the one list page whose feed can answer a text search:
    // contract names and descriptions live in an indexed column pair (the contracts
    // table's FULLTEXT meta_search), so a term is answered by the FEED. Every other
    // list page keeps its box hidden, because with server-side paging a client-side
    // search filters only the ten rows already on screen, which reads as "no results"
    // for a term that has hundreds.
    let nameSearch = (action=='contract' && !emptySearch);
    let baseUrl    = url;
    // Set number of records per page to display
    var sm   = localStorage,
        rec  = sm.getItem('records_per_page');
        page = (rec) ? parseInt(rec) : 10;
    // Detect any 'per page' changes and save to localStorage
    $('#' + tableId).on( 'length.dt', function ( e, settings, length ){
        sm.setItem('records_per_page',length);
    });
    // Load data into the datatable. The config is assembled in a variable rather
    // than passed as a literal so the no-query search state can swap the feed for a
    // local empty dataset without duplicating the rest of it.
    let dtOptions = {
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
        fnDrawCallback: function(o){
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
            // Handle hiding fields with unnecessary info (address / token)
            if(['address','token'].includes(type)){
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
            // Last, so the component sees the rows in their finished state: the
            // per-type hiding above is part of what a permutation has to agree
            // with, and running the hook before it would reorder cells the code
            // above then hides by index.
            if(opts && typeof opts.onDraw === 'function')
                opts.onDraw(tableId, o);
        },
        createdRow: function(row, data, idx){
            // Parse the row data into the standard fields
            let action_index = data[data.length-1];
            let status       = data[data.length-2];
            let count        = data[0];
            let block_index  = data[1];
            let block_index2 = false;
            let timestamp    = data[2];
            let source       = data[3];
            let destination  = false;
            let token        = false;
            let token2       = false;
            let amount       = false;
            let amount2      = false;
            let amount3      = false;
            let coin_index   = false;
            let coin2        = false;
            let coin2_index2 = false;
            let message      = false;
            let value        = false;
            let fee          = false;
            let locks        = false;
            let memo         = false;
            let edit         = false;
            let type2        = false;
            let txt          = '';
            let html         = '';
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
            // Address
            if(action=='address'){
                // A null here means the action does not CARRY this field at all, not
                // that the field is set to the falsy option. An ADDRESS v1 (controller
                // bind/unbind) carries NONE of the v0 preferences, and the old
                // ternaries collapsed "absent" into "Donate"/"False", so every v1 row
                // displayed preferences it had never set. That is worse than rendering
                // nothing: it is plausible and wrong, so it cannot be spotted by eye.
                // Measured on RDOGE: actions 1157 and 1159 return fee_preference null
                // and require_memo null, and both rows read "Donate"/"False".
                $('td', row).eq(4).text(isNull(data[4]) ? '-' : ((data[4]==1) ? 'Destroy' : 'Donate'));
                $('td', row).eq(5).text(isNull(data[5]) ? '-' : ((data[5]==1) ? 'True'    : 'False'));
                $('td', row).eq(6).html(action_link);
            }
            // Airdrop
            if(action=='airdrop'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Balance
            if(action=='balance'){
                token   = data[1];
                amount  = data[2];
                percent = data[3];
                value   = data[4];
                $('td', row).eq(1).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(2).html(formatAmount(amount));
                $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
                html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
                html += ' <span class="badge text-bg-info text-white">$' + numeral(bcmul(value, XC.coin_price, 8)).format('0,0.00') + '</span>';
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), 'view', null, true));
            }
            // Batch
            if(action=='batch'){
                $('td', row).eq(4).html(action_link);
            }
            // Blocks
            if(action=='block'){
                block_index = data[0];
                timestamp   = data[1];
                let actions = String(data[2]).split('|');
                $('td', row).eq(0).html(formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0')));
                $('td', row).eq(1).html(formatLivestamp(timestamp));
                $('td', row).eq(3).html(formatLink('/' + coin + '/block/' + block_index, 'view', null, true));
                actions.forEach(function(val, idx){
                    if(val>0){
                        var num  = numeral(val).format('0,0'),
                            icon = '';
                            name = XC.actions[idx];
                        if(name=='addresses')     icon='fa-gears';  
                        if(name=='airdrops')      icon='fa-parachute-box';  
                        if(name=='batches')       icon='fa-layer-group';  
                        if(name=='broadcasts')    icon='fa-bullhorn';  
                        if(name=='callbacks')     icon='fa-recycle';  
                        if(name=='destroys')      icon='fa-trash';  
                        if(name=='dispensers')    icon='fa-arrows-h';  
                        if(name=='dispenses')     icon='fa-hand-holding-heart';
                        if(name=='dividends')     icon='fa-sitemap';  
                        if(name=='files')         icon='fa-file';  
                        if(name=='issues')        icon='fa-bank';  
                        if(name=='links')         icon='fa-link';  
                        if(name=='lists')         icon='fa-list';  
                        if(name=='messages')      icon='fa-message';  
                        if(name=='mints')         icon='fa-print';  
                        if(name=='orders')        icon='fa-book';  
                        if(name=='order_cancels') icon='fa-book';  
                        if(name=='order_edits')   icon='fa-book';  
                        if(name=='order_matches') icon='fa-book';  
                        if(name=='sends')         icon='fa-send';  
                        if(name=='sleeps')        icon='fa-bed';  
                        if(name=='swaps')         icon='fa-exchange';  
                        if(name=='swap_cancels')  icon='fa-exchange';  
                        if(name=='swap_edits')    icon='fa-exchange';  
                        if(name=='swap_matches')  icon='fa-exchange';  
                        if(name=='sweeps')        icon='fa-truck';
                        // name/num flow into an HTML attribute via .html() below; escape
                        // before it lands in markup so an attribute-breakout can't inject.
                        html += '<a title="' + escapeHtml(num) + ' ' + escapeHtml(name) + '">' + escapeHtml(num) + ' <i class="fa ' + icon + ' me-3"></i></a>';
                    }
                });
                if(html=='')
                    html = 'No transactions found';
                $('td', row).eq(2).html(html);
            }
            // Broadcast
            if(action=='broadcast'){
                message = data[4];
                value   = data[5];
                fee     = data[6];
                // broadcasts.message is nullable and BROADCAST v3 legitimately carries
                // no MESSAGE, so the cell must read empty rather than "null".
                $('td', row).eq(4).text(nullToBlank(message));
                var fmt = (String(value).indexOf('.')==-1) ? fmtInteger : fmtCoin;
                $('td', row).eq(5).html(numeral(value).format(fmt));
                $('td', row).eq(6).html(fee);
                $('td', row).eq(7).html(action_link);
            }
            // Price (PRICE oracle: v0 validator COIN/FIAT snapshot, v0 validator BATCH
            // of rounds, v1 user TOKEN/FIAT oracle).
            //
            // A batch is the shape a validator actually publishes, and its coin, token,
            // fiat, value, fee and pair_count columns are ALL NULL by construction (the
            // first five are v1 oracle columns; pair_count would describe one round out
            // of the window). Reading only those left every validator row a line of
            // dashes over an action that carried an hour of prices. The batch's own
            // fields - the round window, how many rounds it carries and how wide a round
            // is - describe it instead.
            if(action=='price'){
                let version    = data[4];
                let pcoin      = data[5];
                token          = data[6];
                let fiat       = data[7];
                let round      = data[8];
                let firstRound = data[9];
                let lastRound  = data[10];
                let roundCount = data[11];
                let pairCount  = data[12];
                let batchPairs = data[13];
                value          = data[14];
                fee            = data[15];
                // Both bounds, never one: a half-set window is not a window, and a v0
                // single-round row and a v1 oracle carry neither.
                let isBatch    = !isNull(firstRound) && !isNull(lastRound);
                let typeHtml   = (Number(version)===0 ? '<span class="badge text-bg-secondary">Validator (v0)</span>' : '<span class="badge text-bg-primary">User (v1)</span>');
                if(isBatch)
                    typeHtml += ' <span class="badge text-bg-dark">Batch</span>';
                $('td', row).eq(4).html(typeHtml);
                $('td', row).eq(5).text(isNull(pcoin) ? '-' : pcoin);
                $('td', row).eq(6).html(isNull(token) ? '-' : formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(7).text(isNull(fiat) ? '-' : fiat);
                // Rounds: the batch's declared window and its round count; on every
                // other shape the single round the action is about.
                let roundText = isNull(round) ? '-' : numeral(round).format(fmtInteger);
                if(isBatch){
                    roundText = numeral(firstRound).format(fmtInteger) + ' - ' + numeral(lastRound).format(fmtInteger);
                    if(!isNull(roundCount))
                        roundText += ' (' + numeral(roundCount).format(fmtInteger) + ' round' + (Number(roundCount)===1 ? '' : 's') + ')';
                }
                $('td', row).eq(8).text(roundText);
                // Pairs: a single-round row states its own width; a batch states the
                // width of one round in the window, since every round in a batch is one
                // publisher's full snapshot.
                let pairText = '-';
                if(!isNull(pairCount))
                    pairText = numeral(pairCount).format(fmtInteger);
                else if(!isNull(batchPairs))
                    pairText = numeral(batchPairs).format(fmtInteger) + ' per round';
                $('td', row).eq(9).text(pairText);
                $('td', row).eq(10).text(isNull(value) ? '-' : value);
                $('td', row).eq(11).text(isNull(fee) ? '-' : fee);
                $('td', row).eq(12).html(action_link);
            }
            // Controller binding (programmable-policy guard: bind/unbind event on a token or address)
            if(action=='controller'){
                let scope    = data[3];
                let subject  = data[4];
                let aclass   = data[5];
                let guard    = data[6];
                let isUnbind = data[7];
                let cdBlocks = data[8];
                let cdEnd    = data[9];
                // data[3] (scope) is not an address; override the generic source link cell
                $('td', row).eq(3).html(scope=='address'
                    ? '<span class="badge text-bg-info">Address</span>'
                    : '<span class="badge text-bg-secondary">Token</span>');
                $('td', row).eq(4).html(isNull(subject) ? '-' : (scope=='address'
                    ? formatLink('/' + coin + '/address/' + subject, subject)
                    : formatLink(tokenUrl(coin, subject), subject, subject)));
                $('td', row).eq(5).text(isNull(aclass) ? '-' : aclass);
                $('td', row).eq(6).html(isNull(guard) ? '-' : formatLink('/' + coin + '/contract/' + guard, guard));
                $('td', row).eq(7).html(Number(isUnbind)===1
                    ? '<span class="badge text-bg-warning">Unbind</span>'
                    : '<span class="badge text-bg-success">Bind</span>');
                $('td', row).eq(8).text(isNull(cdBlocks) ? '-' : numeral(cdBlocks).format('0,0'));
                $('td', row).eq(9).text(isNull(cdEnd) ? '-' : numeral(cdEnd).format('0,0'));
                $('td', row).eq(10).html(action_link);
            }
            // Deploy chunk (chunked DEPLOY v4 carrier: one base64 code slice of a contract source)
            if(action=='deploy_chunk'){
                let codeHash = data[4];
                let chunkIdx = data[5];
                let total    = data[6];
                $('td', row).eq(4).html(isNull(codeHash) ? '-' : '<span class="font-monospace" title="' + codeHash + '">' + String(codeHash).substring(0,16) + '…</span>');
                $('td', row).eq(5).text(isNull(chunkIdx) ? '-' : numeral(chunkIdx).format('0,0'));
                $('td', row).eq(6).text(isNull(total) ? '-' : numeral(total).format('0,0'));
                $('td', row).eq(7).html(action_link);
            }
            // Callback
            if(action=='callback'){
                token  = data[4];
                token2 = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatLink(tokenUrl(coin, token2), token2, token2));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Credit
            if(action=='credit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Debit
            if(action=='debit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Destroy  
            if(action=='destroy'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(action_link);
            }
            // Dispenser
            if(action=='dispenser'){
                give_coin   = data[4];
                give_token  = data[5];
                give_amount = data[6];
                get_coin   = data[7];
                get_token  = data[8];
                get_amount = data[9];
                give_ownership = data[10];
                if(give_ownership == 1){
                    $('td', row).eq(4).html(formatLink(tokenUrl(give_coin, give_token), give_token, give_token) + ' ' + ownershipBadge());
                } else {
                    $('td', row).eq(4).html(formatLinkAmount(tokenUrl(give_coin, give_token), give_token, give_token, give_amount));
                }
                // Built as a LOCAL, never appended onto the shared `html` scratch variable:
                // see formatNativeCoinLeg for why that mattered.
                let getLeg = isNull(get_token)
                    ? formatNativeCoinLeg(get_amount, get_coin)
                    : formatLinkAmount(tokenUrl(get_coin, get_token), get_token, get_token, get_amount);
                $('td', row).eq(5).html(getLeg);
                $('td', row).eq(6).html(formatLink('/' + coin + '/dispenser/' + action_index, 'view', null, true));
            }
            // Dispense
            if(action=='dispense'){
                give_coin   = data[4];
                give_token  = data[5];
                give_amount = data[6];
                get_coin   = data[7];
                get_token  = data[8];
                get_amount = data[9];
                $('td', row).eq(4).html(formatLinkAmount(tokenUrl(give_coin, give_token), give_token, give_token, give_amount));
                // Local, not the shared `html` scratch variable: see formatNativeCoinLeg.
                let getLeg = isNull(get_token)
                    ? formatNativeCoinLeg(get_amount, get_coin)
                    : formatLinkAmount(tokenUrl(get_coin, get_token), get_token, get_token, get_amount);
                $('td', row).eq(5).html(getLeg);
                $('td', row).eq(6).html(action_link);

            } 
            // Dividend
            if(action=='dividend'){
                token  = data[4];
                token2 = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatLink(tokenUrl(coin, token2), token2, token2));
                $('td', row).eq(6).html(formatAmount(data[6]));
                $('td', row).eq(7).html(action_link);
            }
            // Escrow
            if(action=='escrow'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Fee
            if(action=='fee'){
                token  = data[4];
                amount = data[5];
                type2  = data[6];
                // Fee payment method
                txt  = (type2==1) ? 'Destroy' : 'Donate';
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(numeral(amount).format(fmtCoin));
                $('td', row).eq(6).text(txt);
                $('td', row).eq(8).html(action_link);
            }
            // File
            if(action=='file'){
                // Token-gated FILE: flag it with a lock badge on the Name cell (the
                // file renderer is shared across pages with different column counts,
                // so we annotate an existing cell rather than add a column).
                let gate = data[7];
                if(!isNull(gate))
                    $('td', row).eq(4).append(' <span class="badge text-bg-warning" title="Gated by ' + escapeHtml(gate) + '"><i class="fa fa-lock"></i></span>');
                $('td', row).eq(7).html(action_link);
            }
            // Holder
            if(action=='holder'){
                address = data[1];
                amount  = data[2];
                percent = data[3];
                value   = data[4];
                $('td', row).eq(1).html(formatLink('/' + coin + '/address/' + address, address));
                $('td', row).eq(2).html(formatAmount(amount));
                $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
                html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
                html += ' <span class="badge text-bg-info text-white">$' + numeral(value * XC.coin_price).format(fmtCurrency) + '</span>';
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));
            }
            // Issue
            if(action=='issue'){
                amount  = data[5];
                amount2 = data[6];
                locks   = data[7];
                // data[8] = ownership-transfer destination; when set, this issue
                // moved the token's ownership record (the provenance trail for
                // NFT collections (nft-standard.md#collections))
                let transfer = data[8];
                if(!isNull(transfer))
                    $('td', row).eq(3).html(source_link + ' <i class="fa fa-arrow-right ps-1 pe-1" title="Token ownership transferred"></i> ' + formatLink('/' + coin + '/address/' + transfer, transfer));
                $('td', row).eq(5).text(formatAmount(amount));
                $('td', row).eq(6).text(formatAmount(amount2));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(action_link);
            }
            // Link
            if(action=='link'){
                coin1       = data[4];
                coin1_index = data[5];
                coin2       = data[6];
                coin2_index = data[7];
                memo        = data[8];
                $('td', row).eq(4).html(formatLink('/' + coin1 + '/action/' + coin1_index, coin1 + '-' + coin1_index));
                $('td', row).eq(5).html(formatLink('/' + coin2 + '/action/' + coin2_index, coin2 + '-' + coin2_index));
                // memo reaches the feed through a LEFT JOIN on index_memos, so it is
                // null for the (common) LINK that carries no memo.
                $('td', row).eq(6).text(nullToBlank(memo));
                $('td', row).eq(7).html(action_link);
            }
            // List
            if(action=='list'){
                type2 = data[4];
                edit = data[5];
                // List Type
                txt  = '';
                if(type2==1) txt='Token';
                if(type2==2) txt='Address';
                $('td', row).eq(4).text(txt);
                // Edit Type
                txt = 'Create';
                if(edit==1) txt='Add';
                if(edit==2) txt='Remove';
                $('td', row).eq(5).text(txt);
                $('td', row).eq(6).html(action_link);
            }
            // Markets
            if(action=='market'){
                let tick1  = data[1],
                    tick2  = data[2],
                    market = encodeURIComponent(String(tick1)) + '/' + encodeURIComponent(String(tick2)), // each tick is one free-text segment
                    price  = data[3],
                    ask    = data[4],
                    bid    = data[5],
                    volume = data[6],
                    change = data[7];
                    html   = '<img src="' + getTokenIcon(tick1) + '" class="icon-20">' + 
                             '<img src="' + getTokenIcon(tick2) + '" class="icon-20 ms-1 me-1">' + 
                             escapeHtml(tick1) + ' / ' + escapeHtml(tick2); // ticks are free text inside markup
                $('td', row).eq(1).html(formatLinkHtml('/' + coin + '/market/' + market, html));
                $('td', row).eq(2).html(formatAmount(price));
                $('td', row).eq(3).html(formatAmount(ask));
                $('td', row).eq(4).html(formatAmount(bid));
                $('td', row).eq(5).html(formatAmount(volume));
                var cls = (change && change.indexOf('-')==-1) ? 'text-success' : 'text-danger';
                $('td', row).eq(6).addClass(cls).html(formatAmount(change));
                $('td', row).eq(7).html(formatLink('/' + coin + '/market/' + market, 'view', null, true));
            }
            // Message
            if(action=='message'){
                destination = data[4];
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Mint
            if(action=='mint'){
                token       = data[4];
                amount      = data[5];
                destination = data[6];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                // Write the cell either way: a MINT's DESTINATION is optional, and
                // skipping it leaves the raw feed value DataTables rendered, which
                // for a null column is the word "null".
                $('td', row).eq(6).html(isNull(destination)
                    ? ''
                    : formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Order
            if(action=='order'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                give_ownership = data[8];
                get_ownership  = data[9];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
                $('td', row).eq(6).html(formatLink(tokenUrl(coin, token2), token2, token2));
                $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
                $('td', row).eq(8).html(action_link);
            }
            // Send
            if(action=='send'){
                token       = data[4];
                amount      = data[5];
                destination = data[6];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Sleep
            if(action=='sleep'){
                type2        = data[4];
                token        = data[5];
                block_index2 = data[6];
                // Sleep Type
                txt  = '';
                if(type2==1) txt='Address';
                if(type2==2) txt='Token';
                $('td', row).eq(4).text(txt);
                if(token!='')
                    $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + block_index2, numeral(block_index2).format(fmtInteger)));
                $('td', row).eq(7).html(action_link);
            }
            // Swap
            if(action=='swap'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                give_ownership = data[8];
                get_ownership  = data[9];
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
                $('td', row).eq(6).html(formatLink(tokenUrl(coin, token2), token2, token2));
                $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
                $('td', row).eq(8).html(action_link);
            }
            // Sweep
            if(action=='sweep'){
                destination = data[4];
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
                txt = (data[5]==1) ? 'True' : 'False';
                $('td', row).eq(5).text(txt);
                txt = (data[6]==1) ? 'True' : 'False';
                $('td', row).eq(6).text(txt);
                txt = (data[7]==1) ? 'True' : 'False';
                $('td', row).eq(7).text(txt);
                txt = (data[8]==1) ? 'True' : 'False';
                $('td', row).eq(8).text(txt);
                txt = (data[9]==1) ? 'True' : 'False';
                $('td', row).eq(9).text(txt);
                $('td', row).eq(10).html(action_link);
            }
            // Tokens
            if(action=='token'){
                token   = data[3];
                amount  = data[4];
                amount2 = data[5];
                amount3 = data[6];
                locks   = data[7];
                let tickHtml = formatLink(tokenUrl(coin, token), token, token);
                $('td', row).eq(3).html(tickHtml);
                $('td', row).eq(4).text(formatAmount(amount));
                $('td', row).eq(5).text(formatAmount(amount2));
                $('td', row).eq(6).text(formatAmount(amount3));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(formatLink(tokenUrl(coin, token), 'view', null, true));
            }
            // Official Tokens (project roster; same row shape as Tokens)
            if(action=='project'){
                token   = data[3];
                amount  = data[4];
                amount2 = data[5];
                amount3 = data[6];
                locks   = data[7];
                let pTickHtml = formatLink(tokenUrl(coin, token), token, token);
                $('td', row).eq(3).html(pTickHtml);
                $('td', row).eq(4).text(formatAmount(amount));
                $('td', row).eq(5).text(formatAmount(amount2));
                $('td', row).eq(6).text(formatAmount(amount3));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(formatLink(tokenUrl(coin, token), 'view', null, true));
            }
            // Raw action list: one row per action with its type name; no per-type
            // details on this feed (they live on the action page). No status column
            // on the actions table, so 'action' sits in the no-color list above.
            if(action=='action'){
                let action2 = data[4];
                $('td', row).eq(4).html('<span class="badge text-bg-info">' + escapeHtml(String(action2 || '-')) + '</span>');
                $('td', row).eq(5).html(action_link);
            }
            // Order match: each leg links the matched ORDER's action on its own coin
            // (the match row carries coins and action indexes, not ticks).
            if(action=='order_match'){
                let give_coin  = data[3];
                let give_index = data[4];
                let get_coin   = data[6];
                let get_index  = data[7];
                let settlement = data[9];
                $('td', row).eq(3).html(formatLink('/' + give_coin + '/action/' + give_index, give_coin + '-' + give_index));
                $('td', row).eq(4).html(formatAmount(data[5]));
                $('td', row).eq(5).html(formatLink('/' + get_coin + '/action/' + get_index, get_coin + '-' + get_index));
                $('td', row).eq(6).html(formatAmount(data[8]));
                $('td', row).eq(7).text(isNull(settlement) ? '-' : settlement);
                $('td', row).eq(8).html(action_link);
            }
            // Swap match: same two-leg rendering minus the amount and settlement
            // columns, which a swap match does not carry.
            if(action=='swap_match'){
                let give_coin  = data[3];
                let give_index = data[4];
                let get_coin   = data[5];
                let get_index  = data[6];
                $('td', row).eq(3).html(formatLink('/' + give_coin + '/action/' + give_index, give_coin + '-' + give_index));
                $('td', row).eq(4).html(formatLink('/' + get_coin + '/action/' + get_index, get_coin + '-' + get_index));
                $('td', row).eq(5).html(action_link);
            }
            // History
            if(action=='history'){
                let action2 = data[3];
                let info    = data[4];
                $('td', row).eq(3).html(action2);
                let html = getActionDetails(action2, info);
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(action_link);
            }
            // Market History
            if(action=='market-history'){
                let type   = data[3]
                    price  = bcformat(data[4],8),
                    amount = bcformat(data[5],8),
                    total  = bcformat(bcmul(price, amount),8);
                $('td', row).eq(3).html(type);
                $('td', row).eq(4).html(formatAmount(price));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatAmount(total));
                $('td', row).eq(7).html(action_link);
            }
            // Search
            if(action=='search'){
                if(type=='address'){
                    let address = data[1];
                    $('td', row).eq(1).html(formatLinkHtml('/' + coin + '/address/' + address, highlightSearchTerm(XC.query, address)));
                    $('td', row).eq(2).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));
                }
                if(type=='broadcast'){
                    let message = data[1];
                    let memo    = data[2];
                    $('td', row).eq(1).html(highlightSearchTerm(XC.query, message));
                    $('td', row).eq(2).html(highlightSearchTerm(XC.query, memo));
                    $('td', row).eq(3).html(formatLink('/' + coin + '/action/' + data[3], 'view', null, true));
                }
                if(type=='token'){
                    let token       = data[1];
                    let description = data[2];
                    $('td', row).eq(1).html(formatLinkHtml(tokenUrl(coin, token), highlightSearchTerm(XC.query, token), token));
                    $('td', row).eq(2).html(highlightSearchTerm(XC.query, description));
                    $('td', row).eq(3).html(formatLink(tokenUrl(coin, token), 'view', null, true));
                }
                if(type=='transaction'){
                    let transaction = data[1];
                    $('td', row).eq(1).html(formatLinkHtml('/' + coin + '/transaction/' + transaction, highlightSearchTerm(XC.query, transaction)));
                    $('td', row).eq(2).html(formatLink('/' + coin + '/transaction/' + transaction, 'view', null, true));
                }
                // Contract: the fifth search category, matched on the declared name or
                // description through the contracts FULLTEXT index rather than by LIKE.
                // Name and description are author-supplied on-chain text, so both are
                // hardened before the term highlighter (which escapes) sees them; the
                // derived address is served by the API and is never omitted.
                if(type=='contract'){
                    let meta_name    = data[1];
                    let meta_version = data[2];
                    let address      = data[3];
                    let snippet      = data[4];
                    let idx          = data[5];
                    $('td', row).eq(1).html(isNull(meta_name)
                        ? '<span class="text-muted fst-italic">Unnamed contract</span>'
                        : highlightSearchTerm(XC.query, hardenText(meta_name, 64)));
                    $('td', row).eq(2).text(isNull(meta_version) ? '' : hardenText(meta_version, 32));
                    $('td', row).eq(3).html(formatLink('/' + coin + '/contract/' + idx, address));
                    $('td', row).eq(4).html(highlightSearchTerm(XC.query, hardenText(snippet, 160)));
                    $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + idx, 'view', null, true));
                }
            }
            // Contract (DEPLOY list). The Name cell carries the contract's declared
            // meta.name (spec contract-meta-manifest 2.6), hardened and escaped: it is
            // author-supplied on-chain text reaching an HTML sink. A contract deployed
            // before CONTRACT_META_REQUIRED has none, and reads "Unnamed contract"
            // rather than blank, which would look like a missing value.
            if(action=='contract'){
                let meta_name = data[4];
                let code_hash = data[5];
                let api       = data[6];
                let cooldown  = data[7];
                $('td', row).eq(4).html(formatContractName(meta_name, null));
                $('td', row).eq(5).html(formatHash(code_hash));
                $('td', row).eq(6).text(api);
                $('td', row).eq(7).html(isNull(cooldown) ? 'No' : ('<span class="badge text-bg-info text-white">Stakeable</span> ' + numeral(cooldown).format(fmtInteger) + ' blk'));
                $('td', row).eq(8).html(formatLink('/' + coin + '/contract/' + action_index, 'view', null, true));
            }
            // Execution (EXECUTE list)
            if(action=='execution'){
                let contract_index = data[3];
                let caller         = data[4];
                let method         = data[5];
                let gas            = data[6];
                $('td', row).eq(3).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + caller, caller));
                // contract_executions.method_name is nullable (an EXECUTE that names no
                // method still records a row, with its gas), so blank it rather than "null".
                $('td', row).eq(5).text(nullToBlank(method));
                $('td', row).eq(6).html(numeral(gas).format(fmtInteger));
                $('td', row).eq(7).html(formatLink('/' + coin + '/execution/' + action_index, 'view', null, true));
            }
            // Deposit / Withdrawal (contract custody)
            if(action=='deposit' || action=='withdrawal'){
                let contract_index = data[4];
                token  = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Validator / capability stake. eq(7)-eq(9) are the hub federation registry's
            // view of the SAME signing pubkey (addr / served chains / registration
            // status), folded onto the on-chain active set so one page covers both.

            // Registry strings are hub-supplied free text and render as TEXT, never
            // markup. A null status means no registry was reachable (unknown);
            // 'peered' means the hub has heard this pubkey over P2P but no capability
            // is active yet; 'unregistered' means the hub answered and has never
            // heard from this pubkey.
            if(action=='validator'){
                let pubkey     = data[4];
                let version    = data[5];
                amount         = data[6];
                let hub_addr   = data[7];
                let hub_chains = data[8];
                let hub_status = data[9];
                let reg_cls    = (hub_status=='active')     ? 'success'
                               : (hub_status=='peered')     ? 'info'
                               : (hub_status=='suspended')  ? 'warning text-dark'
                               : (hub_status=='removed')    ? 'danger'
                               : (hub_status=='unregistered') ? 'secondary'
                               : 'light text-dark';
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).text(isNull(hub_addr) ? '-' : hub_addr);
                $('td', row).eq(8).text(isNull(hub_chains) ? '-' : hub_chains);
                $('td', row).eq(9).html($('<span>')
                    .addClass('badge text-bg-' + reg_cls)
                    .text(isNull(hub_status) ? 'unknown' : hub_status));
                $('td', row).eq(10).html(action_link);
            }
            // Raw stake list (all STAKE actions, any status; getStakes shaper, action_index last)
            if(action=='stake'){
                let pubkey  = data[4];
                let version = data[5];
                amount      = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Contract-targeted stake (STAKE v3)
            if(action=='contract_stake'){
                let pubkey         = data[4];
                let contract_index = data[5];
                token  = data[6];
                amount = data[7];
                let version = data[8];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html(action_link);
            }
            // Contract-targeted unstake (UNSTAKE v1)
            if(action=='contract_unstake'){
                let pubkey         = data[4];
                let contract_index = data[5];
                token  = data[6];
                amount = data[7];
                let cooldown_end = data[8];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
                $('td', row).eq(9).html(action_link);
            }
            // Slash event (xchain.contract.slash emission; no own action_index; links to the EXECUTE)
            if(action=='slash_event'){
                let pubkey         = data[3];
                let contract_index = data[4];
                token       = data[5];
                amount      = data[6];
                destination = data[7];
                let execution_index = data[8];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(8).html(formatLink('/' + coin + '/action/' + execution_index, 'view', null, true));
            }
            // Attestation (ATTEST v0 request / v1 response from the `attests` table)
            //
            // TWO status fields ride this feed and they answer different questions.
            // Rendering only the attester's HTTP result, under a heading a reader uses
            // to ask whether the action COUNTED, shows an ATTEST the chain rejected as
            // `ok`. They get a column each: Response is the attester's result (or the
            // request's lifecycle state), Action Status is the chain's verdict on the
            // action itself.
            //
            // Both the verdict and the action index are read POSITIONALLY here rather
            // than through createdRow's generic data[length-1]/data[length-2] tail parse.
            // The getAttestations feed appends payload, callback_params_json and
            // fee_payer AFTER action_index, so on this page alone that parse reads
            // fee_payer as the action index and callback_params_json as the verdict.
            if(action=='attestation'){
                let version         = data[4];
                let provider        = data[5];
                let request_id      = data[6];
                let request_status  = data[7];
                let response_status = data[8];
                $('td', row).eq(4).html((version == 0) ? '<span class="badge text-bg-secondary">Request</span>' : '<span class="badge text-bg-primary">Response</span>');
                $('td', row).eq(5).text(provider);
                let att_status      = data[9];
                let att_index       = data[10];
                let att_valid       = (att_status==1);
                let att_verdict     = att_valid ? 'valid' : 'invalid';
                $(row).removeClass('bg-green bg-red').addClass(att_valid ? 'bg-green' : 'bg-red');
                $('td', row).eq(6).html(formatLinkHtml('/' + coin + '/action/' + att_index, formatHash(request_id)));
                // Both attests.request_status and attests.response_status are nullable
                // ENUMs with no default; each row fills only the one for its version, and
                // an unresolved row leaves even that one NULL.
                $('td', row).eq(7).text(nullToBlank((version == 0) ? request_status : response_status));
                $('td', row).eq(8).html('<span class="badge text-bg-' + (att_valid ? 'success' : 'danger')
                    + ' attestation-action-status" data-action-status="' + att_verdict + '">' + att_verdict + '</span>');
                $('td', row).eq(9).html(formatLink('/' + coin + '/action/' + att_index, 'view', null, true));
            }
            // VOTE poll (polls table; token-weighted governance, VOTE v0). eq(4) token,
            // eq(5) question, eq(6) lifecycle-status badge (open/finalized/failed_quorum),
            // eq(7) close block, eq(8) binding badge (a non-null callback contract means
            // the poll result fires a contract method, i.e. it can move real value),
            // eq(9) the WINNER: winning_option is an INDEX into the poll's options, so
            // option 0 is a real winner and only a null reads as "no outcome recorded".
            // The feed carries the index and the label resolved off the options JSON
            // (getPagingDataResults), because a bare index names nothing to a reader.
            // Option labels are attacker-controlled on-chain bytes, so the cell is
            // written with .text(), exactly like the question above it.
            if(action=='poll'){
                token             = data[4];
                let question      = data[5];
                let poll_status   = data[6];
                let end_block     = data[7];
                let binding       = data[8];
                let winner_index  = data[9];
                let winner_label  = data[10];
                let pcls = (poll_status=='finalized') ? 'success' : (poll_status=='failed_quorum') ? 'danger' : 'warning text-dark';
                $('td', row).eq(4).html(isNull(token) ? '-' : formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).text(isNull(question) ? '-' : question);
                $('td', row).eq(6).html('<span class="badge text-bg-' + pcls + '">' + (poll_status || '-') + '</span>');
                $('td', row).eq(7).html(isNull(end_block) ? '-' : formatLink('/' + coin + '/block/' + end_block, numeral(end_block).format(fmtInteger)));
                $('td', row).eq(8).html(isNull(binding) ? '-' : formatLinkHtml('/' + coin + '/contract/' + binding, '<span class="badge text-bg-danger">Binding</span>', 'Binding poll: finalization calls contract ' + binding));
                $('td', row).eq(9).text(isNull(winner_index) ? '-' : (winner_index + (isNull(winner_label) ? '' : ': ' + winner_label)));
                $('td', row).eq(10).html(action_link);
            }
            // VOTE ballot (votes table; one row per voter choice, VOTE v1). eq(4) links the
            // poll it voted on, eq(5) the chosen option index, eq(6) the split-mode share.
            if(action=='vote'){
                let poll_index = data[4];
                let choice     = data[5];
                let share      = data[6];
                $('td', row).eq(4).html(isNull(poll_index) ? '-' : formatLink('/' + coin + '/action/' + poll_index, poll_index));
                $('td', row).eq(5).text(isNull(choice) ? '-' : choice);
                $('td', row).eq(6).text(isNull(share) ? '-' : share);
                $('td', row).eq(7).html(action_link);
            }
            // BET market (bet_feeds; BET format 0). eq(5) is the market LABEL, which is
            // attacker-controlled on-chain text, so it goes in with .text() and never
            // as markup. The status shown is the STORED feed status.
            if(action=='bet_feed'){
                token            = data[4];
                let label        = data[5];
                let feed_status  = data[6];
                let deadline     = data[7];
                let fcls = (feed_status=='resolved') ? 'success'
                         : (feed_status=='cancelled' || feed_status=='expired') ? 'danger'
                         : (feed_status=='resolved_void') ? 'secondary'
                         : (feed_status=='closed') ? 'warning text-dark' : 'primary';
                $('td', row).eq(4).html(isNull(token) ? '-' : formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).text(isNull(label) ? '-' : label);
                $('td', row).eq(6).html('<span class="badge text-bg-' + fcls + '">' + escapeHtml(String(feed_status || '-')) + '</span>');
                $('td', row).eq(7).html(isNull(deadline) ? '-' : formatLivestamp(deadline));
                // The view button targets the MARKET page, not the raw action page.
                $('td', row).eq(8).html(formatLinkHtml('/' + coin + '/bet_feed/' + data[9], '<i class="fa fa-eye"></i>', 'View market'));
            }
            // BET wager (bets; BET format 2). eq(4) links the market it was placed on.
            if(action=='bet'){
                let feed_index = data[4];
                let outcome    = data[5];
                token          = data[6];
                amount         = data[7];
                let bet_status = data[8];
                let bcls = (bet_status=='won') ? 'success' : (bet_status=='lost') ? 'danger'
                         : (bet_status=='refunded') ? 'secondary' : 'primary';
                $('td', row).eq(4).html(isNull(feed_index) ? '-' : formatLink('/' + coin + '/bet_feed/' + feed_index, feed_index));
                $('td', row).eq(5).text(isNull(outcome) ? '-' : outcome);
                $('td', row).eq(6).html(isNull(token) ? '-' : formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html('<span class="badge text-bg-' + bcls + '">' + escapeHtml(String(bet_status || '-')) + '</span>');
                $('td', row).eq(9).html(action_link);
            }
            // XCALL (cross-chain call, source-chain request row). eq(3) overrides the
            // generic source-address link with the emitting contract.
            if(action=='xcall'){
                let contract_index        = data[3];
                let target_chain          = data[4];
                let target_contract_index = data[5];
                let method                = data[6];
                let request_status        = data[7];
                let cls = (request_status=='completed') ? 'success' : (request_status=='expired') ? 'danger' : (request_status=='pending') ? 'warning text-dark' : 'secondary';
                $('td', row).eq(3).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(4).text(isNull(target_chain) ? '-' : target_chain);
                $('td', row).eq(5).text(isNull(target_contract_index) ? '-' : target_contract_index);
                $('td', row).eq(6).text(isNull(method) ? '-' : method);
                $('td', row).eq(7).html('<span class="badge text-bg-' + cls + '">' + (request_status || '-') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // Collect (validator reward claim; reward_claims)
            if(action=='collect'){
                amount = data[4];
                $('td', row).eq(4).html(formatAmount(amount));
                $('td', row).eq(5).html(action_link);
            }
            // Capability unstake (UNSTAKE v0; begins the global cooldown on a staked key)
            if(action=='unstake'){
                let pubkey       = data[4];
                amount           = data[5];
                let cooldown_end = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
                $('td', row).eq(7).html(action_link);
            }
            // Delegate key revocation (DELEGATE v2/v3; stake_key_revocations)
            if(action=='delegation_revocation'){
                let pubkey       = data[4];
                let deactivation = data[5];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/block/' + deactivation, numeral(deactivation).format(fmtInteger)));
                $('td', row).eq(6).html(action_link);
            }
            // Capability equivocation slash (SLASH wire action; capability_slash_events). No row
            // color (no status); the view links to the SLASH action via slash_action_index.
            if(action=='capability_slash_event'){
                let pubkey             = data[3];
                let capability         = data[4];
                amount                 = data[5];
                let submitter          = data[6];
                let slash_action_index = data[7];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + (capability || '-') + '</span>');
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(isNull(submitter) ? '-' : formatLink('/' + coin + '/address/' + submitter, submitter));
                $('td', row).eq(7).html(formatLink('/' + coin + '/action/' + slash_action_index, 'view', null, true));
            }
            // User token/fiat oracle row (PRICE v1; hub-mirrored, cross-chain). eq(1)/eq(2) override
            // the generic block/time columns (no local block on a mirror row).
            if(action=='oracle_price'){
                let block_time    = data[1];
                let source_chain  = data[2];
                let source_address = data[3];
                token             = data[4];
                let fiat          = data[5];
                value             = data[6];
                $('td', row).eq(1).html(formatLivestamp(block_time));
                $('td', row).eq(2).text(isNull(source_chain) ? '-' : source_chain);
                $('td', row).eq(3).html(isNull(source_address) ? '-' : formatLink('/' + coin + '/address/' + source_address, source_address));
                $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
                $('td', row).eq(5).text(isNull(fiat) ? '-' : fiat);
                $('td', row).eq(6).html(numeral(value).format(fmtCurrency));
            }
            // Anchor (DOGE state checkpoint). eq(3) overrides the generic source link with the chain.
            if(action=='anchor'){
                let chain          = data[3];
                let network        = data[4];
                let version        = data[5];
                let checkpoint_seq = data[6];
                let snapshot_block = data[7];
                let match_count    = data[8];
                $('td', row).eq(3).text(isNull(chain) ? '-' : chain);
                $('td', row).eq(4).text(isNull(network) ? '-' : network);
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(numeral(checkpoint_seq).format(fmtInteger));
                $('td', row).eq(7).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(8).html(numeral(match_count).format(fmtInteger));
                $('td', row).eq(9).html(action_link);
            }
            // Validator reward (validator_rewards; id-keyed accrual ledger, no own action_index)
            if(action=='reward'){
                let pubkey      = data[4];
                let reward_type = data[5];
                amount          = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + (reward_type || '-') + '</span>');
                $('td', row).eq(6).html(formatAmount(amount));
            }
            // Delegation (DELEGATE v0/v1/v2/v3 signing-key delegation)
            if(action=='delegation'){
                let pubkey = data[4];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(action_link);
            }
            // Full-node verification (NODEPROOF v0 possession-proof verdict). eq(3) overrides the
            // generic source link with the verified pubkey; eq(7) badges the pass/fail result.
            if(action=='full_node_verification'){
                let pubkey         = data[3];
                let staking_source = data[4];
                let epoch_height   = data[5];
                let target_height  = data[6];
                let passed         = data[8];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html(isNull(staking_source) ? '-' : formatLink('/' + coin + '/address/' + staking_source, staking_source));
                $('td', row).eq(5).html(numeral(epoch_height).format(fmtInteger));
                $('td', row).eq(6).html(numeral(target_height).format(fmtInteger));
                $('td', row).eq(7).html('<span class="badge text-bg-' + (passed == 1 ? 'success' : 'danger') + '">' + (passed == 1 ? 'Pass' : 'Fail') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // Cross-chain DEX match (hub-mirrored; id-keyed, no per-row view link). eq(1) keeps the
            // generic block link (snapshot_block); eq(2)/eq(3) override network/match_id.
            if(action=='cross_chain_match'){
                let network  = data[2];
                let match_id = data[3];
                let a_chain  = data[4];
                let a_tick   = data[5];
                let a_amount = data[6];
                let b_chain  = data[7];
                let b_tick   = data[8];
                let b_amount = data[9];
                let mstatus  = data[10];
                $('td', row).eq(2).text(isNull(network) ? '-' : network);
                $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
                $('td', row).eq(4).text(isNull(a_chain) ? '-' : a_chain);
                $('td', row).eq(5).html(isNull(a_tick) ? '-' : formatLink(tokenUrl(coin, a_tick), a_tick, a_tick));
                $('td', row).eq(6).html(formatAmount(a_amount));
                $('td', row).eq(7).text(isNull(b_chain) ? '-' : b_chain);
                $('td', row).eq(8).html(isNull(b_tick) ? '-' : formatLink(tokenUrl(coin, b_tick), b_tick, b_tick));
                $('td', row).eq(9).html(formatAmount(b_amount));
                $('td', row).eq(10).html('<span class="badge text-bg-secondary">' + (mstatus || '-') + '</span>');
            }
            // Cross-chain settlement leg (local action-chain row; view links the settlement action)
            if(action=='cross_chain_settlement'){
                let match_id           = data[3];
                let local_action_index = data[4];
                $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
                $('td', row).eq(4).html(isNull(local_action_index) ? '-' : formatLink('/' + coin + '/action/' + local_action_index, local_action_index));
                $('td', row).eq(5).html(action_link);
            }
            // Quorum-signed state checkpoint (hub-mirrored). No action row, so the last
            // column drills into the checkpoint detail page by height rather than into an
            // action, and signer_count is a plain count: the signature VERDICT costs an
            // Ed25519 pass per signer and is only computed when the detail page's Verify
            // control asks for it.
            if(action=='checkpoint'){
                let checkpoint_seq = data[3];
                let snapshot_block = data[4];
                let state_root     = data[5];
                let merkle_root    = data[6];
                let signer_count   = data[7];
                $('td', row).eq(3).text(isNull(checkpoint_seq) ? '-' : checkpoint_seq);
                $('td', row).eq(4).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(5).html(isNull(state_root) ? '-' : formatHash(state_root));
                $('td', row).eq(6).html(isNull(merkle_root) ? '-' : formatHash(merkle_root));
                $('td', row).eq(7).text(isNull(signer_count) ? '-' : signer_count);
                $('td', row).eq(8).html(formatLink('/' + coin + '/checkpoint/' + block_index, 'view', null, true));
            }
            // Per-block SPV commitments (state_tree_roots) plus the covering checkpoint
            // and the ANCHOR that carried it. checkpoint_seq/anchor_action are null when
            // neither exists YET, the normal state near the tip, so both render as a
            // neutral badge rather than an error or a blank. Height is plain text, this
            // section always sitting on the block it describes.
            if(action=='commitment'){
                let height              = data[1];
                let balances_root       = data[2];
                let stakes_root         = data[3];
                let commit_state_root   = data[4];
                let merkle_root         = data[5];
                let contract_state_root = data[6];
                let checkpoint_seq      = data[7];
                let checkpoint_signers  = data[8];
                let anchor_action       = data[9];
                let anchor_version      = data[10];
                $('td', row).eq(1).text(numeral(height).format(fmtInteger));
                $('td', row).eq(2).html(formatHash(balances_root));
                $('td', row).eq(3).html(formatHash(stakes_root));
                $('td', row).eq(4).html(formatHash(commit_state_root));
                $('td', row).eq(5).html(formatHash(merkle_root));
                $('td', row).eq(6).html(isNull(contract_state_root) ? '<span class="text-muted">Not armed</span>' : formatHash(contract_state_root));
                $('td', row).eq(7).html(isNull(checkpoint_seq)
                    ? '<span class="badge text-bg-secondary">Not yet checkpointed</span>'
                    : 'Seq ' + numeral(checkpoint_seq).format(fmtInteger) + ' &middot; ' +
                      numeral(isNull(checkpoint_signers) ? 0 : checkpoint_signers).format(fmtInteger) + ' signers ' +
                      formatLink('/' + coin + '/checkpoint/' + height, 'view', null, true));
                $('td', row).eq(8).html(isNull(anchor_action)
                    ? '<span class="badge text-bg-secondary">Not yet anchored</span>'
                    : 'ANCHOR v' + numeral(anchor_version).format('0') + ' ' +
                      formatLink('/' + coin + '/action/' + anchor_action, 'view', null, true));
            }
            // Validator PBFT price round (hub-mirrored, id-keyed). reference_block names a
            // height on reference_chain, which is not necessarily this coin's chain, so it
            // stays plain text rather than becoming a local block link.
            if(action=='price_snapshot'){
                let block_timestamp = data[1];
                let reference_block = data[2];
                let reference_chain = data[3];
                let coin_pair       = data[4];
                let price           = data[5];
                let validators      = data[6];
                let round           = data[7];
                let round_status    = data[8];
                $('td', row).eq(1).html(formatLivestamp(block_timestamp));
                $('td', row).eq(2).text(isNull(reference_block) ? '-' : numeral(reference_block).format(fmtInteger));
                $('td', row).eq(3).text(isNull(reference_chain) ? '-' : reference_chain);
                $('td', row).eq(4).text(isNull(coin_pair) ? '-' : coin_pair);
                $('td', row).eq(5).text(isNull(price) ? '-' : numeral(price).format(fmtCurrency));
                $('td', row).eq(6).text(isNull(validators) ? '-' : validators);
                $('td', row).eq(7).text(isNull(round) ? '-' : round);
                $('td', row).eq(8).html('<span class="badge text-bg-secondary">' + (round_status || '-') + '</span>');
            }
            // Per-contract emission rollup. Execution and Child Action link to their own
            // action detail pages; Child Action is null for an internal emission (e.g.
            // SLASH) that moves ledger state without minting a new on-wire action.
            if(action=='emission'){
                let execution_index = data[3];
                let contract_index  = data[4];
                let position        = data[5];
                let emitted_action  = data[6];
                let child_action    = data[7];
                let emission_status = data[8];
                $('td', row).eq(3).html(isNull(execution_index) ? '-' : formatLink('/' + coin + '/action/' + execution_index, numeral(execution_index).format(fmtInteger)));
                $('td', row).eq(4).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).text(isNull(position) ? '-' : position);
                $('td', row).eq(6).html(isNull(emitted_action) ? '-' : '<span class="badge text-bg-secondary">' + escapeHtml(emitted_action) + '</span>');
                $('td', row).eq(7).html(isNull(child_action) ? '<span class="text-muted">internal</span>' : formatLink('/' + coin + '/action/' + child_action, numeral(child_action).format(fmtInteger)));
                $('td', row).eq(8).html('<span class="badge text-bg-' + (emission_status=='valid' ? 'success' : 'danger') + '">' + escapeHtml(emission_status || '-') + '</span>');
            }
            // Cross-chain reorg attestation (hub-owned, id-keyed). reorg_height is THIS
            // coin's own chain height (both transports scope to it), so it links to the
            // local block page. reorg_timestamp is stored in MILLISECONDS, unlike
            // price_snapshot's block_timestamp above, which is Unix seconds, so it is
            // divided down before formatLivestamp. The status word is renamed here to avoid
            // shadowing the positional `status` destructured at the top of createdRow.
            if(action=='reorg'){
                let reorg_timestamp = data[1];
                let reorg_height    = data[2];
                let reorg_id        = data[3];
                let affected_chains = data[4];
                let validator_count = data[5];
                let reorg_status    = data[6];
                let chains = [];
                try { chains = JSON.parse(affected_chains) || []; } catch(e){ chains = []; }
                $('td', row).eq(1).html(isNull(reorg_timestamp) ? '-' : formatLivestamp(Math.floor(reorg_timestamp / 1000)));
                $('td', row).eq(2).html(isNull(reorg_height) ? '-' : formatLink('/' + coin + '/block/' + reorg_height, numeral(reorg_height).format(fmtInteger)));
                $('td', row).eq(3).html(isNull(reorg_id) ? '-' : formatHash(reorg_id, 24));
                $('td', row).eq(4).text(chains.length ? chains.join(', ') : '-');
                $('td', row).eq(5).text(isNull(validator_count) ? '-' : validator_count);
                $('td', row).eq(6).html('<span class="badge text-bg-' + (reorg_status=='confirmed' ? 'success' : 'danger') + '">' + escapeHtml(reorg_status || '-') + '</span>');
            }
            // Federation slash proposal (hub-owned, id-keyed). These rows are EVIDENCE,
            // not enforcement, so 'pending' is badged NEUTRAL and labelled
            // 'unadjudicated': red on an unadjudicated accusation reads as a verdict.
            // 'rejected' means DISMISSED, the cleared state rather than a failure.

            // evidence_hash is the sha256 of the evidence the hub holds, never served
            // verbatim, and is shown so a holder of an evidence record can check it
            // matches. The status word is renamed to avoid shadowing the positional
            // `status` destructured at the top of createdRow.
            if(action=='slash_proposal'){
                let created_at       = data[1];
                let validator_pubkey = data[2];
                let offense_type     = data[3];
                let round_number     = data[4];
                let evidence_hash    = data[5];
                let slash_status     = data[6];
                let badges = { pending: 'secondary', approved: 'danger', rejected: 'success', expired: 'secondary' };
                let labels = { pending: 'pending (unadjudicated)', approved: 'approved (penalty applied)', rejected: 'rejected (dismissed)', expired: 'expired' };
                $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
                $('td', row).eq(2).html(isNull(validator_pubkey) ? '-' : formatHash(validator_pubkey));
                $('td', row).eq(3).text(isNull(offense_type) ? '-' : String(offense_type).replace(/_/g, ' '));
                $('td', row).eq(4).html(isNull(round_number) ? '-' : numeral(round_number).format(fmtInteger));
                $('td', row).eq(5).html(isNull(evidence_hash) ? '-' : formatHash(evidence_hash, 24));
                $('td', row).eq(6).html('<span class="badge text-bg-' + (badges[slash_status] || 'secondary') + '">' +
                    escapeHtml(labels[slash_status] || slash_status || '-') + '</span>');
            }
            // Contract-targeted stake delegation. deactivation_block is null while the
            // delegation is live, which is the difference between a current delegation and
            // a historical one, so it renders as a dash rather than being hidden.
            if(action=='contract_delegation'){
                let signing_pubkey  = data[4];
                let contract_index  = data[5];
                let tick            = data[6];
                let activation      = data[7];
                let deactivation    = data[8];
                $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
                $('td', row).eq(5).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(isNull(tick) ? '-' : formatLink(tokenUrl(coin, tick), tick, tick));
                $('td', row).eq(7).text(isNull(activation) ? '-' : numeral(activation).format(fmtInteger));
                $('td', row).eq(8).text(isNull(deactivation) ? '-' : numeral(deactivation).format(fmtInteger));
                $('td', row).eq(9).html(action_link);
            }
            // VOTE v3 liquid-democracy delegation. The row is already the LIVE delegation
            // for its (tick, delegator): revoked and re-pointed rows are excluded
            // server-side, never here. The trailing view button opens the VOTE v3 action
            // detail, where the single-action join renders the delegation itself.
            if(action=='vote_delegation'){
                let tick      = data[3];
                let delegator = data[4];
                let delegate  = data[5];
                $('td', row).eq(3).html(isNull(tick) ? '-' : formatLink(tokenUrl(coin, tick), tick, tick));
                $('td', row).eq(4).html(isNull(delegator) ? '-' : formatLink('/' + coin + '/address/' + delegator, delegator));
                $('td', row).eq(5).html(isNull(delegate) ? '-' : formatLink('/' + coin + '/address/' + delegate, delegate));
                $('td', row).eq(6).html(action_link);
            }
            // COINPAY settlement record. txid/vout name the specific output that paid THIS
            // obligation, so one transaction legitimately appears on several rows.
            if(action=='coinpay'){
                let obligation = data[4];
                let paid       = data[5];
                let txid       = data[6];
                let vout       = data[7];
                $('td', row).eq(4).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
                $('td', row).eq(5).html(isNull(paid) ? '-' : formatAmount(paid));
                $('td', row).eq(6).html(isNull(txid) ? '-' : formatHash(txid));
                $('td', row).eq(7).text(isNull(vout) ? '-' : vout);
                $('td', row).eq(8).html(action_link);
            }
            // COINPAY obligation: who owes what native coin, expiring when. The row carries
            // the LATEST status for the obligation, and no block time of its own (an
            // ORDER_MATCH creates it, so eq(2) shows the payer instead of a timestamp).
            if(action=='coinpay_obligation'){
                let payer      = data[2];
                let payee      = data[3];
                let owed_coin  = data[4];
                let owed       = data[5];
                let expiration = data[6];
                let pay_status = data[7];
                $('td', row).eq(2).html(isNull(payer) ? '-' : formatLink('/' + coin + '/address/' + payer, payer));
                $('td', row).eq(3).html(isNull(payee) ? '-' : formatLink('/' + coin + '/address/' + payee, payee));
                $('td', row).eq(4).text(isNull(owed_coin) ? '-' : owed_coin);
                $('td', row).eq(5).html(isNull(owed) ? '-' : formatAmount(owed));
                // expiration is a Unix TIMESTAMP (coinpay_obligations.expiration is a
                // BIGINT of seconds), not a block height, so it must not be rendered as
                // a block link: on regtest the value is nine digits against a tip in the
                // thousands, and the link resolves to a block that cannot exist.
                $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(7).html('<span class="badge text-bg-secondary">' + (pay_status || '-') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // ORDER_EXPIRE / SWAP_EXPIRE / DISPENSER_EXPIRE: the protocol retiring an
            // unfilled order, an unfilled swap, or a dispenser that reached its expiration
            // height. All three carry the same shape - the expire action, plus a pointer at
            // the record it retired - so one branch renders the pointer for each.
            if(['order_expire','swap_expire','dispenser_expire'].includes(action)){
                let expired = data[4];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(expired) ? '-' : formatLink('/' + coin + '/action/' + expired, expired));
                $('td', row).eq(5).html(action_link);
            }
            // DISPENSER_CLOSE: the owner retiring a dispenser and taking back its remaining
            // escrow. The give/get legs are the CLOSED dispenser's terms, and either leg may
            // be a native coin, which carries NO tick - linking one builds /token/null, so an
            // absent tick renders the coin name unlinked instead.
            if(action=='dispenser_close'){
                let dispenser = data[4];
                let reason    = data[11];
                give_coin   = data[5];
                give_token  = data[6];
                give_amount = data[7];
                get_coin    = data[8];
                get_token   = data[9];
                get_amount  = data[10];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(dispenser) ? '-' : formatLink('/' + coin + '/action/' + dispenser, dispenser));
                $('td', row).eq(5).html(formatCoinLegAmount(coin, give_coin, give_token, give_amount));
                $('td', row).eq(6).html(formatCoinLegAmount(coin, get_coin, get_token, get_amount));
                // 'empty' (the dispenser drained itself) and 'cancelled' (the owner withdrew
                // it) are indistinguishable in every other column, so they carry different
                // badge colours: a reader must be able to tell them apart without reading.
                $('td', row).eq(7).html(isNull(reason)
                    ? '-'
                    : '<span class="badge text-bg-' + ((String(reason)=='cancelled') ? 'warning' : 'secondary') + '">' + escapeHtml(String(reason)) + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // ORDER_CANCEL / SWAP_CANCEL / DISPENSER_CANCEL: the owner pulling a live
            // record off the book. All three carry the same shape - the cancel action, a
            // pointer at the record it cancelled, and the memo explaining why - so one
            // branch renders all three.
            if(['order_cancel','swap_cancel','dispenser_cancel'].includes(action)){
                let cancelled = data[4];
                let why       = data[5];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(cancelled) ? '-' : formatLink('/' + coin + '/action/' + cancelled, cancelled));
                // .text(), not .html(): a memo is arbitrary on-chain bytes.
                $('td', row).eq(5).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(6).html(action_link);
            }
            // ORDER_EDIT / SWAP_EDIT: the owner amending a live record in place. The whole
            // point of the row is WHAT CHANGED, so expiration and the allow/block lists are
            // columns rather than detail-page-only fields. Each is nullable and a null means
            // "this edit left that setting alone", which renders as a dash - dropping the
            // column would hide the difference between an edit that cleared a list and one
            // that never touched it. allow_list/block_list are ACTION INDEXES pointing at a
            // LIST action, not inline lists, so they link like any other action pointer.
            if(['order_edit','swap_edit'].includes(action)){
                let edited     = data[4];
                let expiration = data[5];
                let allowList  = data[6];
                let blockList  = data[7];
                let why        = data[8];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
                // expiration is a Unix TIMESTAMP (seconds), the same field coinpay
                // obligations carry, not a block height.
                $('td', row).eq(5).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(6).html(isNull(allowList) ? '-' : formatLink('/' + coin + '/action/' + allowList, allowList));
                $('td', row).eq(7).html(isNull(blockList) ? '-' : formatLink('/' + coin + '/action/' + blockList, blockList));
                $('td', row).eq(8).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(9).html(action_link);
            }
            // DISPENSER_EDIT: as above, plus give_escrow - a refill is the most common
            // dispenser edit and moves ONLY the escrow, so that row carries a null
            // expiration and a real escrow amount. Both must render on their own.
            if(action=='dispenser_edit'){
                let edited     = data[4];
                let escrow     = data[5];
                let expiration = data[6];
                let allowList  = data[7];
                let blockList  = data[8];
                let why        = data[9];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
                $('td', row).eq(5).text(isNull(escrow) ? '-' : formatAmount(escrow));
                $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(7).html(isNull(allowList) ? '-' : formatLink('/' + coin + '/action/' + allowList, allowList));
                $('td', row).eq(8).html(isNull(blockList) ? '-' : formatLink('/' + coin + '/action/' + blockList, blockList));
                $('td', row).eq(9).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(10).html(action_link);
            }
            // COINPAY_EXPIRE: an obligation nobody paid, closed out at its expiration. No
            // user transaction writes it, so it carries no source of its own and slot 3
            // holds the obligation it retired instead of an address.
            if(action=='coinpay_expire'){
                let obligation = data[3];
                $('td', row).eq(3).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
                $('td', row).eq(4).html(action_link);
            }
            // Per-validator per-capability qualification flags (hub-owned; id-keyed). qualified/
            // self_test_ok/enabled are 0/1 flags rendered as yes/no badges.
            if(action=='validator_capability'){
                let updated_at   = data[1];
                let pubkey       = data[2];
                let capability   = data[3];
                let qualified    = data[4];
                let self_test_ok = data[5];
                let enabled      = data[6];
                let qual_block   = data[7];
                let yesno = (v) => '<span class="badge text-bg-' + (v == 1 ? 'success' : 'secondary') + '">' + (v == 1 ? 'Yes' : 'No') + '</span>';
                $('td', row).eq(1).html(formatLivestamp(updated_at));
                $('td', row).eq(2).html(formatHash(pubkey));
                $('td', row).eq(3).html('<span class="badge text-bg-info">' + (capability || '-') + '</span>');
                $('td', row).eq(4).html(yesno(qualified));
                $('td', row).eq(5).html(yesno(self_test_ok));
                $('td', row).eq(6).html(yesno(enabled));
                $('td', row).eq(7).html(isNull(qual_block) ? '-' : formatLink('/' + coin + '/block/' + qual_block, numeral(qual_block).format(fmtInteger)));
            }
            // Capability snapshot (co-located checkpoint mirror; id-keyed): the HISTORICAL
            // electorate behind the qualification view above. amount is a stake weight, not
            // a token balance, so it is labelled rather than rendered as a bare number;
            // source is the staking source the weight groups under, and is the empty string
            // before stake-weighted-quorum activation, when only the qualifying count
            // mattered.
            if(action=='capability_snapshot'){
                let snapshot_block = data[2];
                let capability     = data[3];
                let signing_pubkey = data[4];
                let amount         = data[5];
                let source_key     = data[6];
                $('td', row).eq(1).html(formatLivestamp(data[1]));
                $('td', row).eq(2).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(3).html('<span class="badge text-bg-info">' + escapeHtml(capability || '-') + '</span>');
                $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
                $('td', row).eq(5).html(isNull(amount) ? '-' : numeral(amount).format(fmtCoin) + ' stake weight');
                $('td', row).eq(6).text(isNull(source_key) || source_key === '' ? '-' : source_key);
            }
            // Per-validator per-provider ATTEST accountability counters (indexer-owned; no
            // action row, so no status badge and no action link - this sits in the no-color
            // list above). slashed_count and quality_score are Phase 4 columns that read 0
            // on every venue today (no producer yet), still surfaced so the column is ready
            // when one ships.
            if(action=='attest_validator_stat'){
                let pubkey     = data[1];
                let provider   = data[2];
                let fulfilled  = data[3];
                let missed     = data[4];
                let slashed    = data[5];
                let quality    = data[6];
                let lastBlock  = data[7];
                $('td', row).eq(1).html(formatHash(pubkey));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + escapeHtml(provider || '-') + '</span>');
                $('td', row).eq(3).text(isNull(fulfilled) ? '-' : numeral(fulfilled).format(fmtInteger));
                $('td', row).eq(4).html('<span class="badge text-bg-' + (Number(missed) > 0 ? 'warning' : 'secondary') + '">' + (isNull(missed) ? '-' : numeral(missed).format(fmtInteger)) + '</span>');
                $('td', row).eq(5).html('<span class="badge text-bg-' + (Number(slashed) > 0 ? 'danger' : 'secondary') + '">' + (isNull(slashed) ? '-' : numeral(slashed).format(fmtInteger)) + '</span>');
                let qClass = (Number(quality) >= 0.9) ? 'success' : (Number(quality) >= 0.5) ? 'warning' : 'danger';
                $('td', row).eq(6).html(isNull(quality) ? '-' : '<span class="badge text-bg-' + qClass + '">' + numeral(quality).format('0.0000') + '</span>');
                $('td', row).eq(7).html(isNull(lastBlock) ? '-' : formatLink('/' + coin + '/block/' + lastBlock, numeral(lastBlock).format(fmtInteger)));
            }
            // Governance parameter proposal (hub-owned; id-keyed). proposal_id links the votes view.
            if(action=='governance_proposal'){
                let proposal_id    = data[1];
                let parameter      = data[2];
                let current_value  = data[3];
                let proposed_value = data[4];
                let pstatus        = data[5];
                let voting_end     = data[6];
                let activation     = data[7];
                let proposer       = data[8];
                $('td', row).eq(1).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
                $('td', row).eq(2).text(isNull(parameter) ? '-' : parameter);
                $('td', row).eq(3).text(isNull(current_value) ? '-' : current_value);
                $('td', row).eq(4).text(isNull(proposed_value) ? '-' : proposed_value);
                $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + (pstatus || '-') + '</span>');
                $('td', row).eq(6).html(formatLivestamp(voting_end));
                $('td', row).eq(7).html(isNull(activation) ? '-' : formatLink('/' + coin + '/block/' + activation, numeral(activation).format(fmtInteger)));
                $('td', row).eq(8).html(formatHash(proposer));
            }
            // Per-validator governance vote (hub-owned; id-keyed). approve=green, reject=red badge.
            if(action=='governance_vote'){
                let created_at  = data[1];
                let proposal_id = data[2];
                let voter       = data[3];
                let vote        = data[4];
                $('td', row).eq(1).html(formatLivestamp(created_at));
                $('td', row).eq(2).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
                $('td', row).eq(3).html(formatHash(voter));
                $('td', row).eq(4).html('<span class="badge text-bg-' + (vote == 'approve' ? 'success' : 'danger') + '">' + (vote || '-') + '</span>');
            }
            // Hub P2P peer roster (hub-owned; id-keyed). is_seed rendered as a badge.
            if(action=='peer'){
                let last_seen    = data[1];
                let addr         = data[2];
                let validator_id = data[3];
                let is_seed      = data[4];
                $('td', row).eq(1).html(isNull(last_seen) ? '-' : formatLivestamp(last_seen));
                $('td', row).eq(2).text(isNull(addr) ? '-' : addr);
                $('td', row).eq(3).html(isNull(validator_id) ? '-' : formatHash(validator_id));
                $('td', row).eq(4).html(is_seed == 1
                    ? '<span class="badge text-bg-primary">Seed</span>'
                    : '<span class="badge text-bg-secondary">Peer</span>');
            }
            // Hub consensus key/value state (hub-owned; id-keyed).
            if(action=='consensus_state'){
                let updated_at = data[1];
                let key_name   = data[2];
                let value      = data[3];
                $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(key_name) ? '-' : key_name) + '</span>');
                $('td', row).eq(3).html(isNull(value) ? '-' : '<code>' + escapeHtml(String(value)) + '</code>');
            }
            // Hub config-oracle parameter store (hub-owned; id-keyed).
            if(action=='config'){
                let updated_at  = data[1];
                let coin_col    = data[2];
                let network_col = data[3];
                let module_col  = data[4];
                let param_name  = data[5];
                let param_value = data[6];
                $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
                $('td', row).eq(2).text(isNull(coin_col) ? '-' : coin_col);
                $('td', row).eq(3).text(isNull(network_col) ? '-' : network_col);
                $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + (isNull(module_col) ? '-' : module_col) + '</span>');
                $('td', row).eq(5).text(isNull(param_name) ? '-' : param_name);
                $('td', row).eq(6).html(isNull(param_value) ? '-' : '<code>' + escapeHtml(String(param_value)) + '</code>');
            }
            // Anonymous xchain-node telemetry ping (hub-owned; id-keyed).
            if(action=='telemetry_ping'){
                let created_at   = data[1];
                let event        = data[2];
                let node_version = data[3];
                let os_platform  = data[4];
                let arch         = data[5];
                let country      = data[6];
                let region       = data[7];
                $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(event) ? '-' : event) + '</span>');
                $('td', row).eq(3).text(isNull(node_version) ? '-' : node_version);
                $('td', row).eq(4).text(isNull(os_platform) ? '-' : os_platform);
                $('td', row).eq(5).text(isNull(arch) ? '-' : arch);
                let loc = [country, region].filter(v => !isNull(v) && v !== '').join(' / ');
                $('td', row).eq(6).text(loc || '-');
            }
        }
    };
    if(emptySearch){
        // No feed, no request: DataTables paints its own zeroRecords row from a
        // local empty dataset, so a bare search page renders an empty-but-correct
        // table in every tab and touches the network zero times. "No records found"
        // would be the wrong words here - nothing was looked up - so this state
        // says what the reader has to do instead.
        dtOptions.data = [];
        dtOptions.language.zeroRecords = 'Enter a search term above to see results';
    } else {
        dtOptions.ajax = {
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
    // The search box asks the feed a QUESTION, it does not filter what is on screen.
    // These feeds take their term as a path segment (/explorer/contracts/<term>/name),
    // never as a request parameter, so the term is turned into a url here. preXhr
    // fires before DataTables extends its base ajax config with settings.ajax, so
    // rewriting .url on the live object retargets THIS request: one fetch per term,
    // not the term's own fetch plus a reload.
    if(nameSearch){
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
    $('#' + tableId).dataTable(dtOptions);
    if(nameSearch)
        $('#' + tableId + '_filter input').attr('placeholder', 'Search contract names');
}
