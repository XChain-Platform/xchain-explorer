/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const orders = require('../../../../src/db/action_detail/orders_sql.js');
const swaps = require('../../../../src/db/action_detail/swaps_sql.js');
const dispensers = require('../../../../src/db/action_detail/dispensers_sql.js');

const CASES = [
    ['ORDER_CANCEL_DETAIL', orders.ORDER_CANCEL_DETAIL, 'orders'],
    ['ORDER_EDIT_DETAIL', orders.ORDER_EDIT_DETAIL, 'orders'],
    ['SWAP_CANCEL_DETAIL', swaps.SWAP_CANCEL_DETAIL, 'swaps'],
    ['SWAP_EDIT_DETAIL', swaps.SWAP_EDIT_DETAIL, 'swaps'],
    ['DISPENSER_CANCEL_QUERY', dispensers.DISPENSER_CANCEL_QUERY, 'dispensers'],
    ['DISPENSER_EDIT_QUERY', dispensers.DISPENSER_EDIT_QUERY, 'dispensers']
];

describe('cancel and edit parent joins', function(){
    for(const [name, statement, table] of CASES){
        it(name + ' keeps the child row when the parent is absent', function(){
            expect(statement).to.match(new RegExp('LEFT\\s+JOIN\\s+' + table + '\\s+\\w+\\s+ON'));
            expect(statement).to.not.match(new RegExp('INNER\\s+JOIN\\s+' + table + '\\s+\\w+\\s+ON'));
        });
    }
});
