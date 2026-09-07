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
 * data-table / columns.js
 *
 * Turns a column config into table markup. This is the file that replaced the
 * ~45 hand-written <thead> blocks (spec M2.2), and it runs on BOTH sides on
 * purpose: the server calls it while composing a list page, and the component's
 * mount calls it in the browser when a theme resolved a different column set
 * than the one the server rendered. One renderer, so the two can never disagree
 * about what a column looks like.
 *
 * A column is:
 *
 *   { label, cls, hidden, order }
 *
 * label  the <th> text, already the display string
 * cls    the class attribute; omit the key entirely for a bare <th>, which is
 *        NOT the same as cls:'' - two list pages ship each form today and the
 *        distinction has to survive, because the markup is compared byte for
 *        byte against the pre-component pages
 * hidden drop the column from the rendered table
 * order  where this column appears, when a theme wants a different sequence
 *
 * CANONICAL ORDER IS THE ARRAY ORDER, and it is not the theme's to change: the
 * /explorer feeds return positional row arrays and xchain.js's createdRow
 * writes into them by index, so element i of this array is field i of the row.
 * A theme's `order` is applied as a DOM permutation AFTER the row is filled
 * (see init.js), never by resequencing the array, precisely so the positional
 * contract with the feed stays intact.
 */

(function(root, factory){

    var api = factory();

    // Browser: a global, matching every other file the pages load.
    if(typeof root !== 'undefined')
        root.XCDataTableColumns = api;

    // Node: the composer requires this to render a list page server-side.
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function(){

    'use strict';

    // The indentation the hand-written pages used. Kept as constants rather
    // than inlined so the byte-parity gate has one place to point at.
    var TH_INDENT = '                        ';
    var TD_INDENT = '                        ';

    // The ordering rule is the runtime's, not this file's: the detail-card's
    // rows and the tab-panel's tabs resequence by exactly the same hidden/order
    // contract, and two copies of it would eventually disagree about what
    // `order: 0` means. Resolved once here rather than per call, because in the
    // browser components.js is already loaded by the time this file runs and in
    // Node the composer requires this file directly.
    var CORE = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);

    // Columns actually rendered, in the order they are rendered.
    function renderOrder(columns){
        return CORE.resolveOrder(columns);
    }

    function visibleCount(columns){
        return renderOrder(columns).length;
    }

    // One <th>. `cls` absent renders <th>, `cls` present renders <th class="...">
    // even when empty, because both forms are in the shipped pages.
    function renderTh(col){
        var cls = (col && Object.prototype.hasOwnProperty.call(col, 'cls'))
            ? ' class="' + col.cls + '"'
            : '';
        return TH_INDENT + '<th' + cls + '>' + (col && col.label !== undefined ? col.label : '') + '</th>';
    }

    // The header rows, indented and newline-joined exactly as the pages had them.
    function renderThead(columns){
        return renderOrder(columns).map(function(i){ return renderTh(columns[i]); }).join('\n');
    }

    // The placeholder row shown until the first ajax draw lands. Its colspan has
    // to be the RENDERED column count, not the array length, or a theme that
    // hides a column leaves the message short of the table's width.
    function renderLoadingRow(columns, text){
        return TD_INDENT + '<td colspan="' + visibleCount(columns) + '" class="loading-data">' + (text || '') + '</td>';
    }

    /**
     * The whole <table> block for a list page, at the indentation the composed
     * page needs it.
     *
     * @param {object} o  { tableClass, action, columns, loading }
     */
    function renderTable(o){
        return '                <table class="' + o.tableClass + '" width="100%" id="datatable-' + o.action + '">\n' +
               '                <thead>\n' +
               '                    <tr class="info">\n' +
               renderThead(o.columns) + '\n' +
               '                    </tr>\n' +
               '                </thead>\n' +
               '                <tbody>\n' +
               '                    <tr>\n' +
               renderLoadingRow(o.columns, o.loading) + '\n' +
               '                    </tr>\n' +
               '                </tbody>\n' +
               '                </table>';
    }

    // True when the config asks for anything the canonical DOM does not already
    // give: a hidden column or a resequenced one. Cheap enough to run per draw,
    // and it keeps the permutation off the hot path for the classic theme, which
    // never reorders anything.
    function needsPermutation(columns){
        var order = renderOrder(columns);
        if(order.length !== columns.length) return true;
        for(var i = 0; i < order.length; i++)
            if(order[i] !== i) return true;
        return false;
    }

    return {
        renderOrder: renderOrder,
        visibleCount: visibleCount,
        renderTh: renderTh,
        renderThead: renderThead,
        renderLoadingRow: renderLoadingRow,
        renderTable: renderTable,
        needsPermutation: needsPermutation
    };

});
