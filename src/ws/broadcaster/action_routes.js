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
 * XChain Explorer - Broadcaster, NEW_ACTION and lifecycle routing
 *
 * The one rule for which channels a NEW_ACTION reaches, and the one rule for
 * which channels a lifecycle event reaches. The live fan-out (Broadcaster
 * onAction / onLifecycleEvent) and the catch-up replay
 * (websocket_server/catch_up.js) both read them, so a reconnecting client is
 * replayed the frames the live feed sent for each missed action row. Lifecycle
 * events with no action row behind them (the detector's NON_ACTION_LIFECYCLE_TYPES)
 * cannot be replayed, and CATCH_UP_COMPLETE names them in `not_replayed`.
 *
 ********************************************************************/

'use strict';

// The channel keys a NEW_ACTION goes to, in delivery order: the coin-wide actions
// channel first, then the address channel of each distinct party (the source and every
// destination). Deduped, so an address that is both source and destination gets one frame.
function actionChannelKeys(coin, source, destinations) {
    const keys = [coin + ':actions'];
    const seen = new Set();
    const parties = [source, ...(Array.isArray(destinations) ? destinations : [])];
    for (const address of parties) {
        if (!address || seen.has(address)) continue;
        seen.add(address);
        keys.push(coin + ':address:' + address);
    }
    return keys;
}

// Does any of these channel keys ever carry a NEW_ACTION? Only actions and address do.
function carriesActions(coin, channelKeys) {
    for (const key of channelKeys) {
        if (key === coin + ':actions' || key.startsWith(coin + ':address:')) return true;
    }
    return false;
}

// The channel keys a lifecycle event goes to, in delivery order: the coin-wide actions
// channel, then the dedicated channel it names (per entity when it carries an entity id,
// else bare), then the address channel of every address its payload names.
function lifecycleChannelKeys(broadcaster, coin, lifecycleEvent) {
    const keys = [coin + ':actions'];
    if (lifecycleEvent.channel) {
        const entityId = broadcaster.lifecycleChannelEntityId(lifecycleEvent);
        keys.push(coin + ':' + lifecycleEvent.channel + (entityId ? ':' + entityId : ''));
    }
    for (const address of broadcaster.extractAddresses(lifecycleEvent.data)) {
        keys.push(coin + ':address:' + address);
    }
    return keys;
}

module.exports = { actionChannelKeys, carriesActions, lifecycleChannelKeys };
