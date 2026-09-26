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
 * XChain Explorer - Channel Manager: channel keys
 *
 * Everything that turns a subscription's identity into the string key the
 * subscription map and the Broadcaster route on, and back: building a key,
 * parsing one, and resolving the entity keys a subscribe or unsubscribe
 * request names, one resolver per entity channel.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so channel_manager.js can copy them onto ChannelManager.prototype
 * verbatim. Nothing here is ever instantiated: `this` is the ChannelManager
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

// Canonical decimal form of an action_index subscription key: no sign, no leading
// zeros, no fraction, no trailing junk. Anything else is a distinct subscription
// identity that the DB would silently coerce back to a real row.
const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

// Canonical form of a call_id subscription key. The id is a 64-hex digest derived
// in the source-chain VM run, and it is compared as a STRING everywhere it is
// routed, so case is part of the identity: normalizing to lower case at
// subscribe time keeps SUBSCRIBED, SUBSCRIPTION_LIST and the Broadcaster's
// routing key on one representation, rather than letting an upper-case
// subscription sit alongside a lower-case event and receive nothing.
const CANONICAL_CALL_ID = /^[0-9a-f]{64}$/;

// Each resolver below pushes the entity keys its channel's params name onto
// `keys` and returns nothing, or returns the { error } result that refuses the
// request. A resolver that refuses part way through a batch has already pushed
// some keys; the caller discards them with the error, as the inline switch did.

function addressKeys(params, keys) {
    if (params.addresses && Array.isArray(params.addresses)) {
        for (const addr of params.addresses) keys.push({ address: addr });
    } else if (params.address) {
        keys.push({ address: params.address });
    } else {
        return { error: { code: 'INVALID_CHANNEL', message: 'address channel requires address or addresses param' } };
    }
}

function tokenKeys(params, keys) {
    // "ticks" as a batch param vs "tick" as singular, but "ticks" is also used as a filter
    // Use context: if subscribing to "token" channel, ticks means entity list
    if (params.tick) {
        keys.push({ tick: params.tick });
    } else if (params.ticks && Array.isArray(params.ticks)) {
        for (const t of params.ticks) keys.push({ tick: t });
    } else {
        return { error: { code: 'INVALID_CHANNEL', message: 'token channel requires tick or ticks param' } };
    }
}

function marketKeys(params, keys) {
    if (params.pairs && Array.isArray(params.pairs)) {
        for (const pair of params.pairs) {
            if (Array.isArray(pair) && pair.length === 2) {
                keys.push({ tick1: pair[0], tick2: pair[1] });
            }
        }
    } else if (params.tick1 && params.tick2) {
        keys.push({ tick1: params.tick1, tick2: params.tick2 });
    } else {
        return { error: { code: 'INVALID_CHANNEL', message: 'market channel requires tick1+tick2 or pairs param' } };
    }
}

// Serves both `dispenser` and `bet_feed`, so the channel name is passed in for
// the error messages.
function actionIndexKeys(channel, params, keys) {
    // Normalize action_index to a canonical decimal STRING at the point of
    // subscription so SUBSCRIBED, SUBSCRIPTION_LIST and UNSUBSCRIBED all carry
    // the same representation (a client may send it as a number or a string).
    // bet_feed shares this shape: the feed id IS its creating action_index.
    //
    // String() alone normalized the TYPE but not the VALUE, so "7junk" and
    // "007" became subscription identities of their own while the snapshot
    // read (db.getDispenserInfo -> WHERE d.action_index=?) coerced them to
    // dispenser 7. The subscriber then saw one snapshot and no live frames,
    // since Broadcaster routes on the canonical index.
    const raw = (params.action_indexes && Array.isArray(params.action_indexes))
        ? params.action_indexes
        : (params.action_index !== undefined ? [params.action_index] : null);
    if (raw === null)
        return { error: { code: 'INVALID_CHANNEL', message: `${channel} channel requires action_index or action_indexes param` } };
    for (const idx of raw) {
        const str = String(idx);
        if (!CANONICAL_INDEX.test(str))
            return { error: { code: 'INVALID_CHANNEL', message: `${channel} channel action_index must be a canonical decimal integer (got: ${str})` } };
        keys.push({ action_index: str });
    }
}

function callIdKeys(params, keys) {
    // Same normalize-at-subscribe rule as the action_index channels above,
    // for the same reason: String() alone would normalize the TYPE but not
    // the VALUE, so 'AB..' and 'ab..' would become two subscription
    // identities while the events routing to only one of them.
    const raw = (params.call_ids && Array.isArray(params.call_ids))
        ? params.call_ids
        : (params.call_id !== undefined ? [params.call_id] : null);
    if (raw === null)
        return { error: { code: 'INVALID_CHANNEL', message: 'xcall channel requires call_id or call_ids param' } };
    for (const id of raw) {
        const str = String(id).toLowerCase();
        if (!CANONICAL_CALL_ID.test(str))
            return { error: { code: 'INVALID_CHANNEL', message: `xcall channel call_id must be a 64-character hex string (got: ${String(id)})` } };
        keys.push({ call_id: str });
    }
}

class ChannelKeys {

    // Build a unique key for a channel subscription
    // Format: "COIN:channel" for global, "COIN:channel:entityId" for entity
    buildChannelKey(coin, channel, entityKey) {
        let key = coin + ':' + channel;
        if (entityKey) {
            if (entityKey.address)      key += ':' + entityKey.address;
            else if (entityKey.tick)    key += ':' + encodeURIComponent(String(entityKey.tick));
            else if (entityKey.tick1)   key += ':' + encodeURIComponent(String(entityKey.tick1)) + ':' + encodeURIComponent(String(entityKey.tick2));
            else if (entityKey.action_index !== undefined) key += ':' + entityKey.action_index;
            // call_id is tested LAST and on its own, not folded into the address
            // branch: an xcall subscription carries no address/tick/action_index, and
            // an event routed by call_id must land on the same key the subscribe built.
            else if (entityKey.call_id !== undefined) key += ':' + entityKey.call_id;
        }
        return key;
    }

    // Public: the channel key for a `subscribed` entry (as returned by subscribe()).
    // Used by the WS server to tell freshly-added subscriptions apart from ones the
    // client already held, so a re-subscribe does not re-trigger the snapshot DB fan-out.
    // A `sub` carries {channel, address?/tick?/tick1?/tick2?/action_index?}, which is
    // exactly the entityKey shape buildChannelKey reads.
    channelKeyForSub(coin, sub) {
        return this.buildChannelKey(coin, sub.channel, sub);
    }

    // Parse a channel key back into components
    parseChannelKey(channelKey) {
        const parts   = channelKey.split(':');
        const coin    = parts[0];
        const channel = parts[1];
        let entityKey = null;

        if (channel === 'address' && parts.length > 2)   entityKey = { address: parts.slice(2).join(':') };
        if (channel === 'token' && parts.length > 2)      entityKey = { tick: decodeURIComponent(parts[2]) };
        if (channel === 'market' && parts.length > 3)     entityKey = { tick1: decodeURIComponent(parts[2]), tick2: decodeURIComponent(parts[3]) };
        // Keep the dispenser action_index as the canonical decimal STRING carried in the
        // channel key. Number() here diverged SUBSCRIPTION_LIST/UNSUBSCRIBED (number) from
        // SUBSCRIBED (client value) and lost precision above 2^53; the v2 wire contract is
        // BIGINT-as-string (ws/schema_version.js:26-29).
        if (channel === 'dispenser' && parts.length > 2)  entityKey = { action_index: parts[2] };
        if (channel === 'bet_feed'  && parts.length > 2)  entityKey = { action_index: parts[2] };
        if (channel === 'xcall'     && parts.length > 2)  entityKey = { call_id: parts[2] };

        return { coin, channel, entityKey };
    }

    // Resolve entity keys from subscribe params (supports batch via plural keys)
    resolveEntityKeys(channel, params) {
        const keys = [];
        let refused;

        // A switch rather than a lookup table: unsubscribe passes channel names
        // through unvalidated, and a table keyed by name would resolve
        // 'constructor' or 'toString' to an inherited function instead of
        // falling to the default refusal.
        switch (channel) {
            case 'address':   refused = addressKeys(params, keys); break;
            case 'token':     refused = tokenKeys(params, keys); break;
            case 'market':    refused = marketKeys(params, keys); break;
            case 'dispenser':
            case 'bet_feed':  refused = actionIndexKeys(channel, params, keys); break;
            case 'xcall':     refused = callIdKeys(params, keys); break;

            default:
                return { error: { code: 'INVALID_CHANNEL', message: `Unknown entity channel: ${channel}` } };
        }
        if (refused) return refused;

        if (keys.length === 0) {
            return { error: { code: 'INVALID_CHANNEL', message: `No entity keys resolved for channel: ${channel}` } };
        }

        return { keys };
    }
}

module.exports = ChannelKeys.prototype;
