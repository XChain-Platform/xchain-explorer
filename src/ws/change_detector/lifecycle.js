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
 * XChain Explorer - Change Detector, lifecycle and attestation events
 *
 * Turns one indexed action into the typed lifecycle events LIFECYCLE_MAP names
 * for it, enriched per family (ORDER_MATCH, the dispenser family, the BET
 * family), and an ATTEST action into its attestation-channel event.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the methods onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the methods sat inline. The
 * per-family enrichment steps are plain module functions, so the detector's
 * method surface is the same set of names it always had.
 *
 * LIFECYCLE_MAP stays defined in change_detector.js beside the two lists the
 * conformance test reconciles with it, and is read here through the class it hangs
 * on (this.constructor). Requiring the entry from a part it requires would hand
 * this file a half-built module.
 *
 ********************************************************************/

'use strict';

class LifecycleEvents {

    // Map an indexed action's type to the lifecycle events it produces (LIFECYCLE_MAP),
    // then enrich each one with the detail its channel needs. An action type that maps
    // to nothing is simply not a lifecycle transition and emits nothing here.
    async emitLifecycleEvents(coin, config, action) {
        const actionType = action.action;
        if (!actionType) return;

        const eventTypes = this.constructor.LIFECYCLE_MAP[actionType];
        if (!eventTypes) return;

        for (const eventType of eventTypes) {
            const lifecycleEvent = baseLifecycleEvent(eventType, actionType, action);

            // Enrich ORDER_MATCH with settlement info and COINPAY_REQUIRED
            if (actionType === 'ORDER_MATCH') {
                await enrichOrderMatch(this, coin, config, action, lifecycleEvent);
            }

            // Enrich DISPENSE with its parent dispenser's action_index: the base
            // payload's action_index is the dispense itself, but SDK consumers
            // correlate on data.dispenser_action_index (xchain-sdk XChainSDK
            // DISPENSE handler). Mirrors the ORDER_MATCH enrichment above.
            if (actionType === 'DISPENSE') {
                try {
                    lifecycleEvent.data.dispenser_action_index =
                        await this.db.getDispenseDispenserIndex(config, action.action_index);
                } catch (e) {
                    // Non-fatal: emit the base event with a null parent index
                    lifecycleEvent.data.dispenser_action_index = null;
                }
            }

            // Route dispenser lifecycle events (DISPENSE / DISPENSER_CLOSED /
            // DISPENSER_EXPIRED) to the dedicated `dispenser` entity channel that
            // the SDK's onDispenser() subscribes to, keyed on the parent
            // dispenser's action_index. Without this they only reached the
            // `actions`/`address` channels, so the SDK's typed dispenser handlers
            // were dead (mirrors the `attestation` channel pattern below).
            if (actionType === 'DISPENSE' || actionType === 'DISPENSER_CLOSE' || actionType === 'DISPENSER_EXPIRE') {
                if (actionType === 'DISPENSER_CLOSE' || actionType === 'DISPENSER_EXPIRE') {
                    await enrichDispenserEnd(this, config, actionType, action, lifecycleEvent);
                }
                lifecycleEvent.channel = 'dispenser';
            }

            // Route BET-family events to the `bet_feed` entity channel, keyed on the
            // PARENT market rather than the action itself, so a market page subscribed
            // to one feed sees every bet placed on it plus its latch/resolve/cancel/
            // expire transitions (§11.1). Same shape as the dispenser routing above.
            if (actionType === 'BET' || actionType === 'BET_EXPIRE') {
                await routeBetEvent(this, config, action, lifecycleEvent);
            }

            this.emit('lifecycle_event', coin, lifecycleEvent);
        }
    }

    // Emit an ATTESTATION_REQUEST / ATTESTATION_RESPONSE event on the dedicated
    // `attestation` channel when a new ATTEST action lands. The raw action row
    // from getActionsSince doesn't carry the version, so we enrich it from the
    // consolidated `attests` table to tell a v0 request from a v1 response.
    async emitAttestationEvents(coin, config, action) {
        if (!action || action.action !== 'ATTEST') return;
        try {
            const row = await this.db.getAttestationByActionIndex(config, action.action_index);
            if (!row) return;
            const isResponse = Number(row.version) === 1;
            this.emit('lifecycle_event', coin, {
                type:    isResponse ? 'ATTESTATION_RESPONSE' : 'ATTESTATION_REQUEST',
                action:  'ATTEST',
                channel: 'attestation',
                data: {
                    action_index:    row.action_index,
                    version:         row.version,
                    request_id:      row.request_id,
                    provider_id:     row.provider_id,
                    contract_index:  row.contract_index   || null,
                    request_status:  row.request_status   || null,
                    response_status: row.response_status  || null,
                    block_index:     row.block_index      || null,
                    source:          action.source        || null,
                    status:          action.status        || null
                }
            });
        } catch (e) {
            // Non-fatal: attestation enrichment failure must not break the poll loop
        }
    }
}

// The payload every lifecycle event starts from, before its family's enrichment.
function baseLifecycleEvent(eventType, actionType, action) {
    return {
        type:   eventType,
        action: actionType,
        data: {
            action_index: action.action_index,
            tx_hash:      action.tx_hash      || null,
            block_index:  action.block_index   || null,
            source:       action.source        || null,
            status:       action.status        || null
        }
    };
}

// The ORDER_MATCH family: the settlement type onto the event, and a coinpay
// settlement's COINPAY_REQUIRED emitted ahead of the match event itself.
async function enrichOrderMatch(detector, coin, config, action, lifecycleEvent) {
    try {
        const settlement = await detector.db.getOrderMatchSettlement(config, action.action_index);
        if (settlement) {
            lifecycleEvent.data.settlement_type = settlement.settlement_type;
        }

        // A coinpay settlement leaves one side owing an on-chain payment, so
        // the match also emits COINPAY_REQUIRED carrying that obligation.
        if (settlement && settlement.settlement_type === 'coinpay') {
            const obligation = await detector.db.getCoinpayObligation(config, action.action_index);
            if (obligation) {
                detector.emit('lifecycle_event', coin, {
                    type:   'COINPAY_REQUIRED',
                    action: 'COINPAY_REQUIRED',
                    data: {
                        obligation_action_index:    obligation.obligation_action_index,
                        order_match_action_index:  obligation.order_match_action_index,
                        payer_address:             obligation.payer_address,
                        payee_address:             obligation.payee_address,
                        coin_amount:               obligation.coin_amount,
                        expiration:                obligation.expiration
                    }
                });
            }
        }
    } catch (e) {
        // Non-fatal: emit the base event without enrichment
    }
}

// The dispenser family's close and expiry: the parent dispenser's action_index,
// read from the lifecycle table the action type names.
async function enrichDispenserEnd(detector, config, actionType, action, lifecycleEvent) {
    const table = actionType === 'DISPENSER_CLOSE' ? 'dispenser_closes' : 'dispenser_expires';
    try {
        lifecycleEvent.data.dispenser_action_index =
            await detector.db.getDispenserLifecycleDispenserIndex(config, table, action.action_index);
    } catch (e) {
        // Non-fatal: emit the base event with a null parent index
        lifecycleEvent.data.dispenser_action_index = null;
    }
}

// The BET family: the parent feed's action_index, the format discriminator, and
// the `bet_feed` channel.
async function routeBetEvent(detector, config, action, lifecycleEvent) {
    try {
        lifecycleEvent.data.feed_action_index =
            await detector.db.getBetActionFeedIndex(config, action.action_index);
    } catch (e) {
        // Non-fatal: emit the base event with a null parent index
        lifecycleEvent.data.feed_action_index = null;
    }
    // The discriminator the single BET event type is useless without:
    // 0 create, 1 cancel, 2 place a bet, 3 resolve. A market page has to
    // tell "someone staked" from "the market just paid out", and those
    // arrive under the same `type`. Null only for a system BET_EXPIRE,
    // which its own event type already identifies.
    lifecycleEvent.data.action_format =
        (action.action_format === undefined || action.action_format === null)
            ? null
            : Number(action.action_format);
    lifecycleEvent.channel = 'bet_feed';
}

module.exports = LifecycleEvents.prototype;
