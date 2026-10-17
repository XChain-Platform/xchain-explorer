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
 *
 * XChain Explorer - Broadcaster: the REORG notice
 *
 * The ChangeDetector emits `reorg` after a rewind moved a cursor back and
 * before it sends any replacement block or row; this part turns it into one
 * REORG frame per subscribed client of that coin.
 *
 * Authored as a class body and exported as that class's prototype, so
 * broadcaster.js can copy the method onto Broadcaster.prototype by
 * descriptor; `this` is the Broadcaster at call time.
 *
 ********************************************************************/

'use strict';

const { COIN_MAP } = require('./coin_map.js');

class ReorgNotice {

    // Announce a rollback to every client of the coin holding a subscription, before the
    // detector sends any replacement row (it emits this event between the rewind and the
    // block and action steps). REORG is an additive frame type: a client that ignores
    // unknown types keeps working, it just goes on holding the rolled-back rows. The
    // frame is not filtered or projected, because it qualifies every channel at once.
    // A client too backed up to take it is shed with 4008 rather than skipped: losing
    // this frame silently would leave its view on the old chain, while a reconnect's
    // catch-up meets the reorg log and answers CATCH_UP_REORGED.
    onReorg(coin, info) {
        const coinInfo = COIN_MAP[coin];
        if (!coinInfo) return;
        for (const client of this.wsServer.getClients().values()) {
            if (client.coin !== coin || !client.subscriptions || client.subscriptions.size === 0) continue;
            if (client.ws.bufferedAmount > this.maxBackpressure) {
                this.shedBackedUpClient(client);
                continue;
            }
            this.send(client, {
                type:      'REORG',
                chain:     coinInfo.chain,
                network:   coinInfo.network,
                timestamp: Date.now(),
                data: {
                    fork_block_index:           info.fork_block_index,
                    first_invalid_action_index: info.first_invalid_action_index
                }
            });
        }
    }
}

module.exports = ReorgNotice.prototype;
