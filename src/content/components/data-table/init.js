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
 * data-table / init.js
 *
 * Mounts the list table (spec M2.2).
 *
 * The paging, the offset cursor and the per-page-length memory are NOT
 * reimplemented here: they live in loadDatatablesData, they are the part of the
 * old pages that was already correct, and rewriting them would have put the
 * feeds' positional-cursor contract at risk for no gain. What this adds is the
 * column layer: the header comes from config, and a theme's reordering or
 * hiding is applied to the drawn rows.
 *
 * Why the permutation runs on the DOM after the row is filled, rather than by
 * resequencing the config: the /explorer feeds return positional arrays and
 * createdRow writes into cell N for field N. Reordering the array would silently
 * put every value in the wrong column. Reordering the rendered cells afterwards
 * cannot, because the header is permuted by the same map.
 */

(function(){

    'use strict';

    // The registry, from wherever this file is running. In the browser it is the
    // global components.js already installed; under Node it is the same module,
    // required, so a suite can drive the SHIPPED mount rather than a copy of it.
    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    var COLS = (typeof XCDataTableColumns !== 'undefined')
        ? XCDataTableColumns
        : ((typeof require === 'function') ? require('./columns.js') : null);

    // Apply a theme's column order/visibility to one <tr> (header or body).
    // `order` is render-position -> canonical-index.
    function permuteRow(tr, order){
        if(!tr) return;
        var cells = [];
        var i;
        for(i = 0; i < tr.children.length; i++)
            cells.push(tr.children[i]);
        // Detach first, then re-append in the configured sequence. Cells the
        // config drops are simply never re-appended.
        for(i = 0; i < cells.length; i++)
            if(cells[i].parentNode === tr) tr.removeChild(cells[i]);
        for(i = 0; i < order.length; i++)
            if(cells[order[i]]) tr.appendChild(cells[order[i]]);
    }

    function permuteTable(table, columns){
        if(!COLS || !COLS.needsPermutation(columns)) return;
        var order = COLS.renderOrder(columns);
        var head  = table.querySelector('thead tr');
        // The header is permuted once and marked, because a redraw does not
        // rebuild it and permuting it twice would undo the first pass.
        if(head && head.getAttribute('data-xc-permuted') !== '1'){
            permuteRow(head, order);
            head.setAttribute('data-xc-permuted', '1');
        }
        var rows = table.querySelectorAll('tbody tr');
        for(var i = 0; i < rows.length; i++){
            if(rows[i].getAttribute('data-xc-permuted') === '1') continue;
            // The placeholder row is one wide cell, not a set of columns.
            if(rows[i].children.length !== columns.length) continue;
            permuteRow(rows[i], order);
            rows[i].setAttribute('data-xc-permuted', '1');
        }
    }

    REG.register('data-table', {

        props: {
            action:     { type: 'string', required: true },
            columns:    { type: 'array',  required: true },
            tableClass: { type: 'string', default: 'table table-striped cell-border view-button table-hover table-condensed' },
            loading:    { type: 'string', default: 'Loading data...' },
            query:      { type: 'string' },
            type:       { type: 'string' }
        },

        mount: function(el, props, ctx){

            var table = (el && el.tagName === 'TABLE') ? el : (el ? el.querySelector('table') : null);
            if(!table)
                throw new Error('no <table> at the mount point');

            // The server already rendered the header from this same config, so
            // the common case is a no-op. It is re-rendered only when the
            // resolved config disagrees with what is on the page, which is what
            // a theme overriding the column set looks like.
            if(COLS){
                var head = table.querySelector('thead tr');
                var want = COLS.renderThead(props.columns);
                if(head && head.innerHTML.indexOf('<th') === -1)
                    head.innerHTML = '\n' + want + '\n                    ';
            }

            var coin = (ctx && ctx.coin) ? ctx.coin : (typeof XC !== 'undefined' ? XC.coin : null);

            if(typeof loadDatatablesData !== 'function')
                throw new Error('loadDatatablesData is not loaded');

            loadDatatablesData(coin, props.action, props.query || null, props.type || null, {
                columns: props.columns,
                // Runs after every draw, including the first. Rows drawn later
                // (paging) are permuted on their own draw.
                onDraw: function(){ permuteTable(table, props.columns); }
            });

            // The placeholder row is replaced by DataTables on the first draw,
            // so nothing here has to clear it.
            return { table: table, columns: props.columns };
        }
    });

    // Exported for the unit suite, which drives the permutation directly rather
    // than standing up DataTables to get at it.
    if(typeof module !== 'undefined' && module.exports)
        module.exports = { permuteTable: permuteTable };

})();
