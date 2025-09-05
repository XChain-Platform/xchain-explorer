/*
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Handle displaying transaction details
function showTransactionDetails(o){
    // Update page with basic transaction details
    formatTransactionLink(o.tx_hash);
    $('#status').text(o.status);
    $('#timestamp').html(formatLivestamp(o.timestamp) + ' (' + moment.unix(o.timestamp).utcOffset(0).format() + ' GMT)');
    $('#source').html(formatLink('/address/' + o.source, o.source));
    $('#fee').html(formatAmount(o.fee.amount) + ' ' + formatLink('/token/' +  o.fee.tick,  o.fee.tick));
    if(o.tx_index){
        $('#block').html('<a href="/block/' + o.block_index + '">' + numeral(o.block_index).format('0,0') + '</a>');
        $('#tx-index').text(numeral(o.tx_index).format('0,0'));
    } else {
        $('#block').text('-');
        $('#tx-index').text('-');
    }
    // Display the specific actions for this tranaction
    var found = false;
    if(o.airdrops  && o.airdrops.length){  found = true; o.airdrops.forEach(function(info,idx){    showAirdrop(idx+1, info);  }); }
    if(o.addresses && o.addresses.length){ found = true; o.addresses.forEach(function(info,idx){   showAddress(idx+1, info);  }); }
    if(o.callbacks && o.callbacks.length){ found = true; o.callbacks.forEach(function(info,idx){   showCallback(idx+1, info); }); }
    if(o.destroys  && o.destroys.length){  found = true; showDestroys(o.destroys); }
    if(o.dividends && o.dividends.length){ found = true; o.dividends.forEach(function(info,idx){   showDividend(idx+1, info); }); }
    if(o.issues    && o.issues.length){    found = true; o.issues.forEach(function(info,idx){      showIssue(idx+1, info);   }); }
    if(o.lists     && o.lists.length){     found = true; o.lists.forEach(function(info,idx){       showList(idx+1, info);    }); }
    if(o.mints     && o.mints.length){     found = true; showMints(o.mints); }
    if(o.sends     && o.sends.length){     found = true; showSends(o.sends); }
    if(o.sweeps    && o.sweeps.length){    found = true; o.sweeps.forEach(function(info,idx){       showSweep(idx+1, info); });}
    if(found){
        $('#additionalInfoNotAvailable').hide();
    } else {
        var status = getTransactionStatus(o);
            txt = (status) ? status : 'unknown';
        $('#tx-status-wrapper').show();
        $('#tx-status').text(status);
    }
    // Activate the first tab by faking a click
    $('#data-tabs li:nth-child(1) .nav-link').click();
}

// Handle displaying address information
function showAddress(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-address-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-address-' + id + '"   type="button" role="tab" aria-controls="tab-pane-address-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-gears"></i> Address</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-address-' + id + '" role="tabpanel" aria-labelledby="tab-address-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="155">Fee Preference</th>' +
                '            <td class="address-fee-preference"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Require memo</th>' +
                '            <td class="address-require-memo"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="address-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic ADDRESS info
    var act = (data.fee_preference==1) ? 'Destroy' : 'Donate',
        txt = data.fee_preference + ' (' + act + ')';
    $('#tab-pane-address-' + id + ' .address-fee-preference').html(txt);
    var act = (data.require_memo==1) ? 'True' : 'False',
        txt = data.require_memo + ' (' + act + ')';
    $('#tab-pane-address-' + id + ' .address-require-memo').html(txt);
    $('#tab-pane-address-' + id + ' .address-status').html(data.status);
}

// Handle displaying airdrop information
function showAirdrop(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-airdrop-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-airdrop-' + id + '"   type="button" role="tab" aria-controls="tab-pane-airdrop-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-parachute-box"></i> Airdrop</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-airdrop-' + id + '" role="tabpanel" aria-labelledby="tab-airdrop-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th>List</th>' +
                '            <td class="airdrop-list"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th width="155">Token</th>' +
                '            <td class="airdrop-token"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Amount</th>' +
                '            <td class="airdrop-amount"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Total</th>' +
                '            <td class="airdrop-total"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Memo</th>' +
                '            <td class="airdrop-memo"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="airdrop-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '        <div class="card-title mb-0 p-1 fw-bold border-bottom">' +
                '            <i class="fa fa-lg fa-users pull-left"></i> Recipients' +
                '        </div>' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="airdrop-' + id + '-recipients">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="quantity">Quantity</th>' +
                '                <th class="">Address</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic AIRDROP info
    $('#tab-pane-airdrop-' + id + ' .airdrop-list').html(formatLink('/tx/' + data.list, data.list));
    $('#tab-pane-airdrop-' + id + ' .airdrop-token').html(formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
    $('#tab-pane-airdrop-' + id + ' .airdrop-amount').html(formatAmount(data.amount));
    $('#tab-pane-airdrop-' + id + ' .airdrop-memo').html(data.memo);
    $('#tab-pane-airdrop-' + id + ' .airdrop-total').html(formatAmount(data.total.amount));
    $('#tab-pane-airdrop-' + id + ' .airdrop-status').html(data.status);
    // Create the datatable so we can add data to it
    $('#airdrop-' + id + '-recipients').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No recipients found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No recipients found",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('#tab-pane-airdrop-' + id + ' .paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count  : info[0],
                amount : info[1],
                address: info[2]
            };
            $('td', row).eq(0).html(numeral(o.count).format('0,0'));
            $('td', row).eq(1).html(formatAmount(o.amount));
            $('td', row).eq(2).html(formatLink('/address/' + o.address, o.address));
        }
    });
    // Add recipients to the datatable
    var recipients = [];
    data.recipients.forEach(function(addr, idx){
        recipients.push([idx+1, data.amount, addr]);
    });
    var table = $('#airdrop-' + id + '-recipients').dataTable().api();
    table.rows.add(recipients);
    table.draw();
}


// Handle displaying callback information
function showCallback(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-callback-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-callback-' + id + '"   type="button" role="tab" aria-controls="tab-pane-callback-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-recycle"></i> Callback</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-callback-' + id + '" role="tabpanel" aria-labelledby="tab-callback-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="155">Token</th>' +
                '            <td class="callback-token"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Callback Token</th>' +
                '            <td class="callback-token2"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Callback Amount</th>' +
                '            <td class="callback-amount"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Total Debits</th>' +
                '            <td class="callback-debits"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Total Credits</th>' +
                '            <td class="callback-credits"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Memo</th>' +
                '            <td class="callback-memo"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="callback-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '        <div class="card-title mb-0 p-1 fw-bold border-bottom">' +
                '            <i class="fa fa-lg fa-users pull-left"></i> Recipients' +
                '        </div>' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="callback-' + id + '-recipients">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="address">Address</th>' +
                '                <th class="quantity">Debits</th>' +
                '                <th class="quantity">Credits</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic CALLBACK info
    $('#tab-pane-callback-' + id + ' .callback-token').html(formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
    $('#tab-pane-callback-' + id + ' .callback-token2').html(formatLink('/token/' + data.callback_tick, data.callback_tick, data.callback_tick + '.png'));
    $('#tab-pane-callback-' + id + ' .callback-amount').html(formatAmount(data.amount));
    $('#tab-pane-callback-' + id + ' .callback-memo').html(data.memo);
    $('#tab-pane-callback-' + id + ' .callback-debits').html(formatAmount(data.total.debits.amount)   + ' ' + formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
    $('#tab-pane-callback-' + id + ' .callback-credits').html(formatAmount(data.total.credits.amount) + ' ' + formatLink('/token/' + data.callback_tick, data.callback_tick, data.callback_tick + '.png'));
    $('#tab-pane-callback-' + id + ' .callback-total').html(formatAmount(data.total.amount));
    $('#tab-pane-callback-' + id + ' .callback-status').html(data.status);
    // Create the datatable so we can add data to it
    $('#callback-' + id + '-recipients').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No recipients found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No recipients found",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('#tab-pane-callback-' + id + ' .paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count  : info[0],
                address: info[1],
                amount : info[2],
                amount2: info[3]
            };
            $('td', row).eq(0).html(numeral(o.count).format('0,0'));
            $('td', row).eq(1).html(formatLink('/address/' + o.address, o.address));
            $('td', row).eq(2).html(formatAmount(o.amount) + ' ' + formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
            $('td', row).eq(3).html(formatAmount(o.amount2) + ' ' + formatLink('/token/' + data.callback_tick, data.callback_tick, data.callback_tick + '.png'));
        }
    });
    // Add recipients to the datatable
    var recipients = [],
        num        = 0;
    for(const [address,debit] of Object.entries(data.debits)){
        num++;
        credit = (data.credits[address]) ? data.credits[address] : 0;
        recipients.push([num, address, debit, credit]);
    }

    // var recipients = [];
    // data.debits.forEach(function(addr, idx){
    //     // recipients.push([idx+1, data.amount, addr]);
    // });

    var table = $('#callback-' + id + '-recipients').dataTable().api();
    table.rows.add(recipients);
    table.draw();
}

// Handle displaying destroy information
function showDestroys(data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-destroys" data-bs-toggle="tab" data-bs-target="#tab-pane-destroys"   type="button" role="tab" aria-controls="tab-pane-destroys"   aria-selected="true"><i class="fa fa-lg fa-trash"></i> Destroys</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-destroys" role="tabpanel" aria-labelledby="tab-destroys" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="destroys">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="token">Token</th>' +
                '                <th class="quantity">Quantity</th>' +
                '                <th class="memo">Memo</th>' +
                '                <th class="status">Status</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    // Add tab and panel to view
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Create the datatable so we can add data to it
    $('#destroys').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('.paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
            // Update page to display total number of records
            $('#total_records').text(numeral(total).format('0,0'));
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count:  info[0],
                tick:   info[1],
                amount: info[2],
                memo:   info[3],
                status: info[4]
            };
            // Tweak the row color to indicate if orders is open or not
            var cls = (o.status=='valid') ? 'bg-green' : 'bg-red';
            $(row).addClass(cls);
            $('td', row).eq(1).html(formatLink('/token/' +  o.tick,  o.tick,  o.tick + '.png'));
            $('td', row).eq(2).html(formatAmount(o.amount));
            $('td', row).eq(3).text(o.memo);
            $('td', row).eq(4).text(o.status);
        }
    });
    // Splice in destroy #
    var destroys = [];
    data.forEach(function(info, idx){
        destroys.push([idx+1, info.tick, info.amount, info.memo, info.status]);
    });
    var table = $('#destroys').dataTable().api();
    table.rows.add(destroys);
    table.draw();
}


// Handle displaying dividend information
function showDividend(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-dividend-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-dividend-' + id + '"   type="button" role="tab" aria-controls="tab-pane-dividend-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-sitemap"></i> Dividend</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-dividend-' + id + '" role="tabpanel" aria-labelledby="tab-dividend-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="155">Token</th>' +
                '            <td class="dividend-token"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th width="155">Dividend Token</th>' +
                '            <td class="dividend-dividend-token"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Amount</th>' +
                '            <td class="dividend-amount"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Total</th>' +
                '            <td class="dividend-total"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Memo</th>' +
                '            <td class="dividend-memo"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="dividend-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '        <div class="card-title mb-0 p-1 fw-bold border-bottom">' +
                '            <i class="fa fa-lg fa-users pull-left"></i> Recipients' +
                '        </div>' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="dividend-' + id + '-recipients">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="quantity">Quantity</th>' +
                '                <th class="">Address</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic AIRDROP info
    $('#tab-pane-dividend-' + id + ' .dividend-token').html(formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
    $('#tab-pane-dividend-' + id + ' .dividend-dividend-token').html(formatLink('/token/' + data.dividend_tick, data.dividend_tick, data.dividend_tick + '.png'));
    $('#tab-pane-dividend-' + id + ' .dividend-amount').html(formatAmount(data.amount));
    $('#tab-pane-dividend-' + id + ' .dividend-memo').html(data.memo);
    $('#tab-pane-dividend-' + id + ' .dividend-status').html(data.status);
    $('#tab-pane-dividend-' + id + ' .dividend-total').html(formatAmount(data.total.amount));
    // Create the datatable so we can add data to it
    $('#dividend-' + id + '-recipients').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No recipients found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No recipients found",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('#tab-pane-dividend-' + id + ' .paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count  : info[0],
                amount : info[1],
                address: info[2]
            };
            $('td', row).eq(0).html(numeral(o.count).format('0,0'));
            $('td', row).eq(1).html(formatAmount(o.amount));
            $('td', row).eq(2).html(formatLink('/address/' + o.address, o.address));
        }
    });
    // Add recipients to the datatable
    var recipients = [],
        num        = 0;
    for(const [address,amount] of Object.entries(data.recipients)){
        num++;
        recipients.push([num, amount, address]);
    }
    var table = $('#dividend-' + id + '-recipients').dataTable().api();
    table.rows.add(recipients);
    table.draw();
}


// Handle displaying issue information
function showIssue(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-issue-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-issue-' + id + '"   type="button" role="tab" aria-controls="tab-pane-issue-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-bank"></i> Issue</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-issue-' + id + '" role="tabpanel" aria-labelledby="tab-issue-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="150">Ticker</th>' +
                '            <td class="issue-ticker"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Description</th>' +
                '            <td class="issue-description" style="overflow-wrap: anywhere;"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Decimals</th>' +
                '            <td class="issue-decimals"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Max Supply</th>' +
                '            <td class="issue-max-supply"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Max Mint</th>' +
                '            <td class="issue-max-mint"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Mint Supply</th>' +
                '            <td class="issue-mint-supply"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Mint Address Max</th>' +
                '            <td class="issue-mint-address-max"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Mint Start Block</th>' +
                '            <td class="issue-mint-start-block"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Mint Stop Block</th>' +
                '            <td class="issue-mint-stop-block"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Transfer Supply</th>' +
                '            <td class="issue-transfer-supply"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Callback Block</th>' +
                '            <td class="issue-callback-block"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Callback Ticker</th>' +
                '            <td class="issue-callback-tick"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Callback Amount</th>' +
                '            <td class="issue-callback-amount"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Allow List</th>' +
                '            <td class="issue-allow-list"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Block List</th>' +
                '            <td class="issue-block-list"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Max Supply</th>' +
                '            <td class="issue-lock-max-supply"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Mint</th>' +
                '            <td class="issue-lock-mint"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Mint Supply</th>' +
                '            <td class="issue-lock-mint-supply"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Description</th>' +
                '            <td class="issue-lock-description"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Rug</th>' +
                '            <td class="issue-lock-rug"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Sleep</th>' +
                '            <td class="issue-lock-sleep"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Lock Callback</th>' +
                '            <td class="issue-lock-callback"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Transfer To</th>' +
                '            <td class="issue-transfer"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="issue-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic ISSUE info
    $('#tab-pane-issue-' + id + ' .issue-transfer').html(formatLink('/address/' + data.transfer, data.transfer));
    $('#tab-pane-issue-' + id + ' .issue-ticker').html(formatLink('/token/' + data.tick, data.tick, data.tick + '.png'));
    $('#tab-pane-issue-' + id + ' .issue-decimals').text(data.decimals);
    $('#tab-pane-issue-' + id + ' .issue-max-supply').text(data.max_supply);
    $('#tab-pane-issue-' + id + ' .issue-max-mint').text(data.max_mint);
    $('#tab-pane-issue-' + id + ' .issue-mint-supply').text(data.mint_supply);
    $('#tab-pane-issue-' + id + ' .issue-transfer-supply').html(formatLink('/address/' + data.transfer_supply, data.transfer_supply));
    $('#tab-pane-issue-' + id + ' .issue-callback-block').text(data.callback_block);
    $('#tab-pane-issue-' + id + ' .issue-callback-tick').text(data.callback_tick);
    $('#tab-pane-issue-' + id + ' .issue-callback-amount').text(data.callback_amount);
    $('#tab-pane-issue-' + id + ' .issue-description').text(data.description);
    $('#tab-pane-issue-' + id + ' .issue-allow-list').html(formatLink('/tx/' + data.allow_list, data.allow_list));
    $('#tab-pane-issue-' + id + ' .issue-block-list').html(formatLink('/tx/' + data.block_list, data.block_list));
    $('#tab-pane-issue-' + id + ' .issue-mint-address-max').text(data.mint_address_max);
    $('#tab-pane-issue-' + id + ' .issue-mint-start-block').text(data.mint_start_block);
    $('#tab-pane-issue-' + id + ' .issue-mint-stop-block').text(data.mint_stop_block);
    $('#tab-pane-issue-' + id + ' .issue-lock-max-supply').text(data.lock_max_supply);
    $('#tab-pane-issue-' + id + ' .issue-lock-mint').text(data.lock_mint);
    $('#tab-pane-issue-' + id + ' .issue-lock-mint-supply').text(data.lock_mint_supply);
    $('#tab-pane-issue-' + id + ' .issue-lock-description').text(data.lock_description);
    $('#tab-pane-issue-' + id + ' .issue-lock-rug').text(data.lock_rug);
    $('#tab-pane-issue-' + id + ' .issue-lock-sleep').text(data.lock_sleep);
    $('#tab-pane-issue-' + id + ' .issue-lock-callback').text(data.lock_callback);    
    $('#tab-pane-issue-' + id + ' .issue-status').text(data.status);    
}

// Handle displaying list information
function showList(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-list-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-list-' + id + '"   type="button" role="tab" aria-controls="tab-pane-list-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-list"></i> List</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-list-' + id + '" role="tabpanel" aria-labelledby="tab-list-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="155">Type</th>' +
                '            <td class="list-type"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Edit</th>' +
                '            <td class="list-edit"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>List</th>' +
                '            <td class="list-hash"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="list-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '    <ul class="nav nav-tabs" id="data-tabs-list-' + id + ' " role="tablist">' +
                '        <li class="nav-item" role="presentation"><button class="nav-link active" id="tab-list-' + id + '-button"><i class="fa fa-lg fa-list"></i> List Items</button></li>' +
                '        <li class="nav-item" role="presentation"><button class="nav-link "       id="tab-edit-' + id + '-button"><i class="fa fa-lg fa-edit"></i> List Edits</button></li>' +
                '    </ul>' +
                '    <div class="tab-content border border-top-0 mb-3" id="list-data-panels-' + id + '">' +
                '        <div class="tab-pane fade show active table-responsive" id="tab-pane-item-list-' + id + '" role="tabpanel" aria-labelledby="tab-list-' + id + '-button" tabindex="0">' +
                '            <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%" id="list-items-' + id + '">' +
                '            <thead>' +
                '            </thead>' +
                '            <tbody>' +
                '            </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="tab-pane fade table-responsive" id="tab-pane-item-edit-' + id + '" role="tabpanel" aria-labelledby="tab-edit-' + id + '" tabindex="0">' +
                '            <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%" id="list-edits-' + id + '">' +
                '            <thead>' +
                '            </thead>' +
                '            <tbody>' +
                '            </tbody>' +
                '            </table>' +
                '        </div>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Update basic LIST info
    var type = '';
    if(data.type==1) type = 'Tick';
    if(data.type==2) type = 'Asset';
    if(data.type==3) type = 'Address';
    var edit = '';
    if(data.edit==1) edit = 'Add';
    if(data.edit==2) edit = 'Remove';
    $('#tab-pane-list-' + id + ' .list-type').html(data.type + ' (' + type + ')');
    if(edit!='')
        $('#tab-pane-list-' + id + ' .list-edit').text(data.edit + ' (' + edit + ')');
    $('#tab-pane-list-' + id + ' .list-hash').html(formatLink('/tx/' + data.list_tx_hash, data.list_tx_hash));
    $('#tab-pane-list-' + id + ' .list-status').html(data.status);
    // Datatable Config
    var listConfig = {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No items found",
            info: "_TOTAL_ results",
            // info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },

    };
    // Update List tables with Type header
    $('#list-items-' + id + ' thead').html('<tr><th class="record">#</th><th>' + type + '</th></tr>');
    $('#list-edits-' + id + ' thead').html('<tr><th class="record">#</th><th>' + type + '</th><th>Status</th></tr>');
    // Set hostname for asset links and define link
    var link = '',
        host = 'xchain.io'
    if(data.type==1) link = '/token/';
    if(data.type==2) link = 'https://' + host + '/asset/';
    if(data.type==3) link = '/address/';
    // Populate the List Items table
    var body = $('#list-items-' + id + ' tbody'),
        html = '';
    data.items.forEach(function(item, idx){
        html += '<tr><td>' + (idx+1) + '</td><td>'+ formatLink(link + item, item) + '</td></tr>';
    })
    body.html(html);
    // Populate the List Edits table
    var body  = $('#list-edits-' + id + ' tbody'),
        html  = '',
        cnt   = 0,
        edits = data.edits;
    for(const item in edits){
        cnt++;
        var status = edits[item];
            cls    = (status=='valid') ? 'bg-green' : 'bg-red';
        html += '<tr class="' + cls + '"><td>' + cnt + '</td><td>' + formatLink(link + item, item) + '</td><td>' + data.edits[item]+ '</td></tr>';
    }                    
    body.html(html);
    var listTab = $('#tab-list-' + id + '-button'),
        editTab = $('#tab-edit-' + id + '-button'),
        listPanel = $('#tab-pane-item-list-' + id),
        editPanel = $('#tab-pane-item-edit-' + id);
    // Toggle list tab when user clicks it
    listTab.click(function(e){
        listTab.addClass('active');
        listPanel.addClass('show active');
        editTab.removeClass('active');
        editPanel.removeClass('show active');
    });
    // Toggle edit tab when user clicks it
    editTab.click(function(e){
        editTab.addClass('active');
        editPanel.addClass('show active');
        listTab.removeClass('active');
        listPanel.removeClass('show active');
    });
    // Load the datatable after a brief delay to let stuff settle in DOM
    setTimeout(function(){
        $('#list-items-' + id).dataTable(listConfig);
        $('#list-edits-' + id).dataTable(listConfig);
    }, 100);
}

// Handle displaying mint information
function showMints(data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-mints" data-bs-toggle="tab" data-bs-target="#tab-pane-mints"   type="button" role="tab" aria-controls="tab-pane-mints"   aria-selected="true"><i class="fa fa-lg fa-print"></i> Mints</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-mints" role="tabpanel" aria-labelledby="tab-mints" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="mints">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="token">Token</th>' +
                '                <th class="quantity">Quantity</th>' +
                '                <th class="address">Destination</th>' +
                '                <th class="status">Status</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    // Add tab and panel to view
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Create the datatable so we can add data to it
    $('#mints').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('.paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
            // Update page to display total number of records
            $('#total_records').text(numeral(total).format('0,0'));
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count:       info[0],
                tick:        info[1],
                amount:      info[2],
                destination: info[3],
                status:      info[4]
            };
            // Tweak the row color to indicate if orders is open or not
            var cls = (o.status=='valid') ? 'bg-green' : 'bg-red';
            $(row).addClass(cls);
            $('td', row).eq(1).html(formatLink('/token/' +  o.tick,  o.tick,  o.tick + '.png'));
            $('td', row).eq(2).html(formatAmount(o.amount));
            $('td', row).eq(3).html(formatLink('/address/' + o.destination, o.destination));
            $('td', row).eq(4).text(o.status);
        }
    });
    var mints = [];
    data.forEach(function(info, idx){
        mints.push([idx+1, info.tick, info.amount, info.destination, info.status]);
    });
    var table = $('#mints').dataTable().api();
    table.rows.add(mints);
    table.draw();
}


// Handle displaying destroy information
function showSends(data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-sends" data-bs-toggle="tab" data-bs-target="#tab-pane-sends"   type="button" role="tab" aria-controls="tab-pane-sends"   aria-selected="true"><i class="fa fa-lg fa-send"></i> Sends</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-sends" role="tabpanel" aria-labelledby="tab-sends" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-striped cell-border table-hover table-condensed" width="100%" id="sends">' +
                '        <thead>' +
                '            <tr class="info">' +
                '                <th class="record">#</th>' +
                '                <th class="token">Token</th>' +
                '                <th class="quantity">Quantity</th>' +
                '                <th class="address">Destination</th>' +
                '                <th class="memo">Memo</th>' +
                '                <th class="status">Status</th>' +
                '            </tr>' +
                '        </thead>' +
                '        <tbody>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '</div>';
    // Add tab and panel to view
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    // Create the datatable so we can add data to it
    $('#sends').dataTable( {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // dom: '<"search-options center"<"pull-left hidden-xs"l>p<"pull-right hidden-xs"i>><"search-results"t>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function( o ){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            if(total==0)
                page = 0;
            // Add 'Page X of Y' in between previous/next buttons
            $('.paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;')
            // Update page to display total number of records
            $('#total_records').text(numeral(total).format('0,0'));
        },
        createdRow: function(row, info, idx){
            // Create data object
            var o = {
                count:       info[0],
                tick:        info[1],
                amount:      info[2],
                destination: info[3],
                memo:        info[4],
                status:      info[5]
            };
            // Tweak the row color to indicate if orders is open or not
            var cls = (o.status=='valid') ? 'bg-green' : 'bg-red';
            $(row).addClass(cls);
            $('td', row).eq(1).html(formatLink('/token/' +  o.tick,  o.tick,  o.tick + '.png'));
            $('td', row).eq(2).html(formatAmount(o.amount));
            $('td', row).eq(3).html(formatLink('/address/' + o.destination, o.destination));
            $('td', row).eq(4).text(o.memo);
            $('td', row).eq(5).text(o.status);
        }
    });
    // Splice in destroy #
    var sends = [];
    data.forEach(function(info, idx){
        sends.push([idx+1, info.tick, info.amount, info.destination, info.memo, info.status]);
    });
    var table = $('#sends').dataTable().api();
    table.rows.add(sends);
    table.draw();
}


// Handle displaying sweep information
function showSweep(id, data){
    var tab   = '<li class="nav-item" role="presentation"><button class="nav-link" id="tab-sweep-' + id + '" data-bs-toggle="tab" data-bs-target="#tab-pane-sweep-' + id + '"   type="button" role="tab" aria-controls="tab-pane-sweep-' + id + '"   aria-selected="true"><i class="fa fa-lg fa-truck"></i> Sweep</button></li>',
        panel = '<div class="tab-pane fade table-responsive" id="tab-pane-sweep-' + id + '" role="tabpanel" aria-labelledby="tab-sweep-' + id + '" tabindex="0">' +
                '    <div class="table-responsive">' +
                '        <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%">' +
                '        <tbody>' +
                '        <tr>' +
                '            <th width="155">Destination</th>' +
                '            <td class="sweep-destination"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Balances</th>' +
                '            <td class="sweep-balances"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Ownerships</th>' +
                '            <td class="sweep-ownerships"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Memo</th>' +
                '            <td class="sweep-memo"></td>' +
                '        </tr>' +
                '        <tr>' +
                '            <th>Status</th>' +
                '            <td class="sweep-status"></td>' +
                '        </tr>' +
                '        </tbody>' +
                '        </table>' +
                '    </div>' +
                '    <ul class="nav nav-tabs" id="data-tabs-sweep-' + id + ' " role="tablist">' +
                '        <li class="nav-item" role="presentation"><button class="nav-link active" id="tab-balances-' + id + '-button"><i class="fa fa-lg fa-list"></i> Balances</button></li>' +
                '        <li class="nav-item" role="presentation"><button class="nav-link "       id="tab-ownerships-' + id + '-button"><i class="fa fa-lg fa-bank"></i> Ownerships</button></li>' +
                '    </ul>' +
                '    <div class="tab-content border border-top-0" id="sweep-data-panels-' + id + '">' +
                '        <div class="tab-pane fade show active table-responsive" id="tab-pane-balances-' + id + '" role="tabpanel" aria-labelledby="tab-balances-' + id + '-button" tabindex="0">' +
                '            <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%" id="sweep-balances-' + id + '">' +
                '            <thead>' +
                '                <th class="record">#</th>' +
                '                <th>Token</th>' +
                '                <th>Amount</th>' +
                '            </thead>' +
                '            <tbody>' +
                '            </tbody>' +
                '            </table>' +
                '        </div>' +
                '        <div class="tab-pane fade table-responsive" id="tab-pane-ownerships-' + id + '" role="tabpanel" aria-labelledby="tab-ownerships-' + id + '" tabindex="0">' +
                '            <table class="table table-sm table-striped table-hover table-bordered mb-0" width="100%" id="sweep-ownerships-' + id + '">' +
                '            <thead>' +
                '                <th class="record">#</th>' +
                '                <th>Token</th>' +
                '            </thead>' +
                '            <tbody>' +
                '            </tbody>' +
                '            </table>' +
                '        </div>' +
                '    </div>' +
                '</div>';
    $(tab).insertBefore("#data-last-tab");
    $('#data-panels').append(panel);
    $('#tab-pane-sweep-' + id + ' .sweep-destination').html(formatLink('/address/' + data.destination, data.destination));
    var balances   = (data.balances==1) ? 'True' : 'False';
    var ownerships = (data.ownerships==1) ? 'True' : 'False';
    $('#tab-pane-sweep-' + id + ' .sweep-balances').html(balances);
    $('#tab-pane-sweep-' + id + ' .sweep-ownerships').html(ownerships);
    $('#tab-pane-sweep-' + id + ' .sweep-memo').html(data.memo);
    $('#tab-pane-sweep-' + id + ' .sweep-status').html(data.status);
    // Datatable Config
    var listConfig = {
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
        // pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No items found",
            info: "_TOTAL_ results",
            // info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },

    };
    // Populate the balances table
    var body = $('#sweep-balances-' + id + ' tbody'),
        html = '',
        num  = 0;
    for(const [tick,amount] of Object.entries(data.data.balances)){
        num++;
        html += '<tr><td>' + num + '</td><td>'+ formatLink('/token/' + tick, tick) + '</td><td>'+ formatAmount(amount) + '</td></tr>';
    }
    body.html(html);
    // Populate the ownerships table
    var body  = $('#sweep-ownerships-' + id + ' tbody'),
        html  = '';
    data.data.ownerships.forEach(function(tick, idx){
        console.log('tick=',tick);
        html += '<tr><td>' + (idx+1) + '</td><td>' + formatLink('/token/' + tick, tick) + '</td></tr>';
    });        
    body.html(html);
    var balancesTab     = $('#tab-balances-' + id + '-button'),
        balancesPanel   = $('#tab-pane-balances-' + id),
        ownershipsTab   = $('#tab-ownerships-' + id + '-button'),
        ownershipsPanel = $('#tab-pane-ownerships-' + id);
    // Toggle balances tab when user clicks it
    balancesTab.click(function(e){
        balancesTab.addClass('active');
        balancesPanel.addClass('show active');
        ownershipsTab.removeClass('active');
        ownershipsPanel.removeClass('show active');
    });
    // Toggle balances tab when user clicks it
    ownershipsTab.click(function(e){
        ownershipsTab.addClass('active');
        ownershipsPanel.addClass('show active');
        balancesTab.removeClass('active');
        balancesPanel.removeClass('show active');
    });
    // Load the datatable after a brief delay to let stuff settle in DOM
    setTimeout(function(){
        $('#sweep-balances-' + id).dataTable(listConfig);
        $('#sweep-ownerships-' + id).dataTable(listConfig);
    }, 100);



}






