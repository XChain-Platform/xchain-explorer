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

const { getLogger } = require('../../observability');
const log = getLogger();

class LifecycleEvents {

    // Resolve failure-sensitive lifecycle reads before any row is emitted. A read
    // failure aborts the batch while its action cursor is still unchanged.
    async prefetchLifecycleReads(config, batch) {
        if (!batch || batch.lifecycleReads !== undefined) return;
        const reads = {
            betParents: new Map(), dispenserMutations: new Map(),
            orderMatchSettlements: new Map(), coinpayObligations: new Map(),
            attestRows: new Map(), attestExpiries: new Map()
        };
        for (const action of batch.actions || []) {
            const key = String(action.action_index);
            try {
                if (action.action === 'BET' || action.action === 'BET_EXPIRE')
                    reads.betParents.set(key, await this.db.getBetActionFeedIndex(config, action.action_index));
                else if (action.action === 'BET_EDIT')
                    reads.betParents.set(key, await this.db.getValidBetEditFeedIndex(config, action.action_index));
                else if (action.action === 'DISPENSER_CANCEL' || action.action === 'DISPENSER_EDIT')
                    reads.dispenserMutations.set(key, await this.db.getValidDispenserMutationIndex(
                        config, action.action, action.action_index));
                else if (action.action === 'ORDER_MATCH') {
                    const settlement = await this.db.getOrderMatchSettlement(config, action.action_index);
                    reads.orderMatchSettlements.set(key, settlement);
                    if (settlement && settlement.settlement_type === 'coinpay')
                        reads.coinpayObligations.set(key,
                            await this.db.getCoinpayObligation(config, action.action_index));
                } else if (action.action === 'ATTEST') {
                    const row = await this.db.getAttestationByActionIndex(config, action.action_index);
                    reads.attestRows.set(key, row);
                    if (!row && Number(action.action_format) === 2 &&
                        typeof this.db.seedAttestationFromExpireAction === 'function')
                        reads.attestExpiries.set(key,
                            await this.db.seedAttestationFromExpireAction(config, action.action_index));
                }
            } catch (e) {
                log.warn('CHANGE_DETECTOR_LIFECYCLE_READ_FAILED', {
                    coin: config.coin, action: action.action, action_index: action.action_index,
                    err: e && e.message
                });
                throw e;
            }
        }
        batch.lifecycleReads = reads;
    }

    // Map an indexed action's type to the lifecycle events it produces (LIFECYCLE_MAP),
    // then enrich each one with the detail its channel needs. An action type that maps
    // to nothing is simply not a lifecycle transition and emits nothing here. `batch`
    // is the poll's (or the replay's) { actions, parties } cache, so the parties of
    // every system action in it come from one read.
    async emitLifecycleEvents(coin, config, action, batch) {
        const actionType = action.action;
        if (!actionType) return;

        const eventTypes = this.constructor.LIFECYCLE_MAP[actionType];
        if (!eventTypes) return;

        const parties = await lifecyclePartiesOf(this, config, action, batch);
        for (const eventType of eventTypes) {
            const lifecycleEvent = baseLifecycleEvent(eventType, actionType, action);
            if (parties) lifecycleEvent.data.destinations = parties.slice();
            const routed = await enrichAndRouteLifecycleEvent(
                this, coin, config, actionType, action, lifecycleEvent, batch);
            if (!routed) continue;
            this.emit('lifecycle_event', coin, lifecycleEvent);
        }
    }

    // Emit an ATTESTATION_REQUEST / ATTESTATION_RESPONSE event on the dedicated
    // `attestation` channel when a new ATTEST action lands. The raw action row
    // carries no version, so the `attests` row the action wrote supplies it.
    async emitAttestationEvents(coin, config, action, batch) {
        if (!action || action.action !== 'ATTEST') return;
        try {
            const reads = batch && batch.lifecycleReads;
            const row = reads ? reads.attestRows.get(String(action.action_index)) :
                await this.db.getAttestationByActionIndex(config, action.action_index);
            const event = row ? attestRowEvent(row, action) :
                await attestExpiryEvent(this, config, action, reads);
            if (event) this.emit('lifecycle_event', coin, event);
        } catch (e) {
            log.warn('CHANGE_DETECTOR_ATTESTATION_READ_FAILED', {
                coin: config.coin, action_index: action.action_index, err: e && e.message
            });
        }
    }
}

// The event type each `attests` row version sends: a v0 request and a v1 response,
// relay legs included since they write v0 and v1 rows. A batch head (v5), a batch
// continuation (v6) or any other version sends nothing here; NEW_ACTION still has it.
const ATTEST_EVENT_TYPES = new Map([[0, 'ATTESTATION_REQUEST'], [1, 'ATTESTATION_RESPONSE']]);

// The attestation-channel event for an ATTEST action that wrote its own row, or null
// when that row's version sends none.
function attestRowEvent(row, action) {
    const type = ATTEST_EVENT_TYPES.get(Number(row.version));
    if (!type) return null;
    return attestEvent(type, {
        action_index:    row.action_index,
        version:         row.version,
        request_id:      row.request_id,
        provider_id:     row.provider_id,
        contract_index:  row.contract_index   || null,
        request_status:  row.request_status   || null,
        response_status: row.response_status  || null,
        block_index:     row.block_index      || null
    }, action);
}

// The ATTESTATION_RESPONSE an expiry (ATTEST v2) sends. The expiry writes no row of
// its own, it only marks its request expired, so the request is found through the
// in-block pairing REST uses; an expiry it cannot pair sends nothing.
async function attestExpiryEvent(detector, config, action, reads) {
    // Only an expiry has no row of its own; any other missing row sends nothing.
    if (Number(action.action_format) !== 2) return null;
    // A db without the pairing read (a test double) cannot name the request.
    if (typeof detector.db.seedAttestationFromExpireAction !== 'function') return null;
    const request = reads ? reads.attestExpiries.get(String(action.action_index)) :
        await detector.db.seedAttestationFromExpireAction(config, action.action_index);
    if (!request) return null;
    return attestEvent('ATTESTATION_RESPONSE', {
        action_index:    action.action_index,
        version:         2,
        request_id:      request.request_id,
        provider_id:     request.provider_id,
        contract_index:  request.contract_index   || null,
        request_status:  request.request_status   || null,
        response_status: null,
        block_index:     action.block_index       || null
    }, action);
}

// One attestation-channel event: the row fields, then the action's source and status.
function attestEvent(type, fields, action) {
    return {
        type,
        action:  'ATTEST',
        channel: 'attestation',
        data: Object.assign(fields, {
            source: action.source || null,
            status: action.status || null
        })
    };
}

// The parties of an action the indexer mints itself (it has no source), as an array
// for the frame's `destinations`, which address routing and the SDK's address guard
// both read. Null for any other action type, and null when the batch read failed, so
// the frame still goes out on its other channels. Without a batch the action reads
// alone.
async function lifecyclePartiesOf(detector, config, action, batch) {
    if (typeof detector.db.getLifecycleParties !== 'function') return null;
    const scope = batch || { actions: [action] };
    if (scope.parties === undefined) {
        try {
            scope.parties = await detector.db.getLifecycleParties(config, scope.actions);
        } catch (e) {
            scope.parties = null;
            log.warn('CHANGE_DETECTOR_LIFECYCLE_PARTIES_FAILED', { coin: config.coin, err: e && e.message });
        }
    }
    const parties = scope.parties ? scope.parties.get(String(action.action_index)) : null;
    return parties ? [...parties] : null;
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

async function enrichAndRouteLifecycleEvent(
    detector, coin, config, actionType, action, lifecycleEvent, batch
) {
    if (actionType === 'ORDER_MATCH') {
        await enrichOrderMatch(detector, coin, config, action, lifecycleEvent, batch);
    }

    await routeDispenserEvent(detector, config, actionType, action, lifecycleEvent);
    if (actionType === 'DISPENSER_CANCEL' || actionType === 'DISPENSER_EDIT') {
        return routeValidDispenserMutation(
            detector, config, actionType, action, lifecycleEvent, batch);
    }

    if (actionType === 'BET' || actionType === 'BET_EXPIRE') {
        await routeBetEvent(detector, config, action, lifecycleEvent, batch);
    }
    if (actionType === 'BET_EDIT') {
        return routeValidBetEdit(detector, config, action, lifecycleEvent, batch);
    }
    return true;
}

async function routeDispenserEvent(detector, config, actionType, action, lifecycleEvent) {
    if (actionType === 'DISPENSE') {
        try {
            lifecycleEvent.data.dispenser_action_index =
                await detector.db.getDispenseDispenserIndex(config, action.action_index);
        } catch (e) {
            lifecycleEvent.data.dispenser_action_index = null;
        }
    }

    if (actionType !== 'DISPENSE' &&
        actionType !== 'DISPENSER_CLOSE' && actionType !== 'DISPENSER_EXPIRE') return;
    if (actionType === 'DISPENSER_CLOSE' || actionType === 'DISPENSER_EXPIRE') {
        await enrichDispenserEnd(detector, config, actionType, action, lifecycleEvent);
    }
    lifecycleEvent.channel = 'dispenser';
}

// The ORDER_MATCH family: the settlement type onto the event, and a coinpay
// settlement's COINPAY_REQUIRED emitted ahead of the match event itself.
async function enrichOrderMatch(detector, coin, config, action, lifecycleEvent, batch) {
    try {
        const reads = batch && batch.lifecycleReads;
        const key = String(action.action_index);
        const settlement = reads ? reads.orderMatchSettlements.get(key) :
            await detector.db.getOrderMatchSettlement(config, action.action_index);
        if (settlement) {
            lifecycleEvent.data.settlement_type = settlement.settlement_type;
        }

        // A coinpay settlement leaves one side owing an on-chain payment, so
        // the match also emits COINPAY_REQUIRED carrying that obligation.
        if (settlement && settlement.settlement_type === 'coinpay') {
            const obligation = reads ? reads.coinpayObligations.get(key) :
                await detector.db.getCoinpayObligation(config, action.action_index);
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
        log.warn('CHANGE_DETECTOR_ORDER_MATCH_READ_FAILED', {
            coin: config.coin, action_index: action.action_index, err: e && e.message
        });
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

async function routeValidDispenserMutation(detector, config, actionType, action, lifecycleEvent, batch) {
    try {
        const reads = batch && batch.lifecycleReads;
        const dispenserIndex = reads ? reads.dispenserMutations.get(String(action.action_index)) :
            await detector.db.getValidDispenserMutationIndex(config, actionType, action.action_index);
        if (dispenserIndex === null || dispenserIndex === undefined) return false;
        lifecycleEvent.data.dispenser_action_index = dispenserIndex;
        lifecycleEvent.channel = 'dispenser';
        return true;
    } catch (e) {
        log.warn('CHANGE_DETECTOR_DISPENSER_MUTATION_READ_FAILED', {
            coin: config.coin, action: actionType, action_index: action.action_index,
            err: e && e.message
        });
        return false;
    }
}

// The BET family: the parent feed's action_index, the format discriminator, and
// the `bet_feed` channel.
async function routeBetEvent(detector, config, action, lifecycleEvent, batch) {
    const reads = batch && batch.lifecycleReads;
    lifecycleEvent.data.feed_action_index = reads
        ? reads.betParents.get(String(action.action_index))
        : await detector.db.getBetActionFeedIndex(config, action.action_index);
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

async function routeValidBetEdit(detector, config, action, lifecycleEvent, batch) {
    const reads = batch && batch.lifecycleReads;
    const feedIndex = reads
        ? reads.betParents.get(String(action.action_index))
        : await detector.db.getValidBetEditFeedIndex(config, action.action_index);
    if (feedIndex === null || feedIndex === undefined) return false;
    lifecycleEvent.data.feed_action_index = feedIndex;
    lifecycleEvent.data.action_format =
        (action.action_format === undefined || action.action_format === null)
            ? null
            : Number(action.action_format);
    lifecycleEvent.channel = 'bet_feed';
    return true;
}

module.exports = LifecycleEvents.prototype;
