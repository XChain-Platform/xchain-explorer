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
 **********************************************************************
 * Scalar fields from the full action detail view that identify the compact
 * summary for system expiry, roll-call and bridge actions.
 */

'use strict';

module.exports = Object.freeze({
    BET_EXPIRE: Object.freeze([
        'feed_action_index',
        'tick',
        'refund_count',
        'refund_amount'
    ]),
    ROLLCALL: Object.freeze([
        'epoch_height'
    ]),
    XBRIDGE: Object.freeze([
        'tick',
        'dest_chain',
        'dest_address',
        'bridge_kind',
        'transfer_id'
    ]),
    COINPAY_EXPIRE: Object.freeze([
        'obligation_action_index'
    ])
});
