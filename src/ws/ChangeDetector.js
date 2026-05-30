/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Explorer - Change Detector
 *
 * Polls the indexer database at a configurable interval to detect
 * new blocks and actions. When changes are detected, fetches the
 * new data, maps actions to lifecycle events, and passes everything
 * to the Broadcaster. Only fetches entity details when subscribers
 * exist for those channels.
 *
 ********************************************************************/

const EventEmitter = require('events');

// Mapping from indexed action type to WebSocket lifecycle event types
const LIFECYCLE_MAP = {
    'ORDER_MATCH':     ['ORDER_MATCH'],
    'COINPAY':         ['COINPAY_FULFILLED'],
    'COINPAY_EXPIRE':  ['COINPAY_EXPIRED'],
    'ORDER_EXPIRE':    ['ORDER_EXPIRED'],
    'SWAP_MATCH':      ['SWAP_MATCH'],
    'SWAP_EXPIRE':     ['SWAP_EXPIRED'],
    'DISPENSE':        ['DISPENSE'],
    'DISPENSER_CLOSE': ['DISPENSER_CLOSED'],
    'DISPENSER_EXPIRE':['DISPENSER_EXPIRED']
};

class ChangeDetector extends EventEmitter {

    constructor(options) {
        super();
        this.db             = options.db;
        this.channelManager = options.channelManager || null;
        this.pollInterval   = options.pollInterval || 5000;
        this.fetchLimit     = options.fetchLimit   || 100;

        // Track last known state per coin (e.g., "BTC", "TBTC", "RLTC")
        this.state = {};

        // Polling timer reference
        this.timer   = null;
        this.running = false;
    }

    // Start the polling loop
    start(coins) {
        if (this.running) return;
        this.running = true;

        for (const coin of coins) {
            if (!this.state[coin]) {
                this.state[coin] = { blockIndex: 0, actionIndex: 0, initialized: false };
            }
        }

        this.timer = setInterval(() => this._poll(), this.pollInterval);
        this._poll();

        console.log('ChangeDetector started — polling every', this.pollInterval, 'ms for', coins.join(', '));
    }

    // Stop the polling loop
    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // Single poll cycle
    async _poll() {
        if (!this.running) return;

        for (const coin of Object.keys(this.state)) {
            try {
                await this._checkCoin(coin);
            } catch (e) {
                console.log('ChangeDetector poll error for', coin, ':', e);
            }
        }
    }

    // Check a single coin for changes
    async _checkCoin(coin) {
        const config = { coin };
        const prev   = this.state[coin];

        const currentBlockIndex  = await this.db.getMaxBlockIndex(config) || 0;
        const currentActionIndex = await this.db.getMaxActionIndex(config) || 0;

        // First poll — seed state without emitting
        if (!prev.initialized) {
            prev.blockIndex  = currentBlockIndex;
            prev.actionIndex = currentActionIndex;
            prev.initialized = true;
            return;
        }

        // New blocks
        if (currentBlockIndex > prev.blockIndex) {
            const newBlocks = await this.db.getBlocksSince(config, prev.blockIndex, this.fetchLimit);
            if (newBlocks && newBlocks.length > 0) {
                for (const block of newBlocks) {
                    this.emit('block', coin, block);
                }
            }
            prev.blockIndex = currentBlockIndex;
        }

        // New actions
        if (currentActionIndex > prev.actionIndex) {
            const newActions = await this.db.getActionsSince(config, prev.actionIndex, this.fetchLimit);
            if (newActions && newActions.length > 0) {
                for (const action of newActions) {
                    // Emit the raw action event
                    this.emit('action', coin, action);

                    // Emit lifecycle events
                    await this._emitLifecycleEvents(coin, config, action);

                    // Emit entity updates for subscribed entities
                    await this._emitEntityUpdates(coin, config, action);

                    // Emit attestation events (dedicated `attestation` channel)
                    await this._emitAttestationEvents(coin, config, action);
                }
            }
            prev.actionIndex = currentActionIndex;
        }
    }

    // Map an indexed action to lifecycle events
    async _emitLifecycleEvents(coin, config, action) {
        const actionType = action.action;
        if (!actionType) return;

        const eventTypes = LIFECYCLE_MAP[actionType];
        if (!eventTypes) return;

        for (const eventType of eventTypes) {
            const lifecycleEvent = {
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

            // Enrich ORDER_MATCH with settlement info and COINPAY_REQUIRED
            if (actionType === 'ORDER_MATCH') {
                try {
                    const settlement = await this.db.getOrderMatchSettlement(config, action.action_index);
                    if (settlement) {
                        lifecycleEvent.data.settlement_type = settlement.settlement_type;
                    }

                    // If coinpay settlement, also emit COINPAY_REQUIRED
                    if (settlement && settlement.settlement_type === 'coinpay') {
                        const obligation = await this.db.getCoinpayObligation(config, action.action_index);
                        if (obligation) {
                            this.emit('lifecycle_event', coin, {
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
                    // Non-fatal — emit the base event without enrichment
                }
            }

            this.emit('lifecycle_event', coin, lifecycleEvent);
        }
    }

    // Emit entity updates when subscribed entities are affected by a new action
    async _emitEntityUpdates(coin, config, action) {
        if (!this.channelManager) return;

        // Check if any subscribed addresses are involved
        const subscribedAddresses = this.channelManager.getSubscribedAddresses(coin);
        if (subscribedAddresses.size > 0) {
            const involvedAddresses = new Set();
            if (action.source && subscribedAddresses.has(action.source))           involvedAddresses.add(action.source);
            if (action.destination && subscribedAddresses.has(action.destination)) involvedAddresses.add(action.destination);

            for (const addr of involvedAddresses) {
                try {
                    const balances = await this.db.getAddressBalances(config, addr);
                    this.emit('entity_update', coin, {
                        type:    'ADDRESS_UPDATE',
                        channel: 'address',
                        data: {
                            address:           addr,
                            balances:          balances || [],
                            last_action_index: action.action_index
                        }
                    });
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        // Check subscribed tokens — only if the action involves a tick field
        // The action data from getActionsSince doesn't include tick directly,
        // so we check if any token subscribers exist and emit updates for affected tokens
        // This is a lightweight check — full tick resolution would require joining more tables
        const subscribedTicks = this.channelManager.getSubscribedTicks(coin);
        if (subscribedTicks.size > 0 && ['ISSUE', 'MINT', 'DESTROY', 'SEND', 'AIRDROP', 'DIVIDEND'].includes(action.action)) {
            for (const tick of subscribedTicks) {
                try {
                    const tokenInfo = await this.db.getTokenInfo(config, tick);
                    if (tokenInfo) {
                        this.emit('entity_update', coin, {
                            type:    'TOKEN_UPDATE',
                            channel: 'token',
                            data: {
                                tick:              tick,
                                supply:            tokenInfo.supply,
                                holders:           tokenInfo.holders,
                                last_action_index: action.action_index
                            }
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        // Check subscribed dispensers
        const subscribedDispensers = this.channelManager.getSubscribedDispensers(coin);
        if (subscribedDispensers.size > 0 && ['DISPENSE', 'DISPENSER', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE'].includes(action.action)) {
            for (const dispenserIdx of subscribedDispensers) {
                try {
                    const dispenserInfo = await this.db.getDispenserInfo(config, dispenserIdx);
                    if (dispenserInfo) {
                        this.emit('entity_update', coin, {
                            type:    'DISPENSER_UPDATE',
                            channel: 'dispenser',
                            data:    dispenserInfo
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        // Check subscribed markets
        const subscribedMarkets = this.channelManager.getSubscribedMarkets(coin);
        if (subscribedMarkets.length > 0 && ['ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP', 'SWAP_MATCH'].includes(action.action)) {
            for (const market of subscribedMarkets) {
                try {
                    const marketInfo = await this.db.getMarketInfo(config, market.tick1, market.tick2);
                    if (marketInfo) {
                        this.emit('entity_update', coin, {
                            type:    'MARKET_UPDATE',
                            channel: 'market',
                            data:    marketInfo
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }
    }

    // Emit an ATTESTATION_REQUEST / ATTESTATION_RESPONSE event on the dedicated
    // `attestation` channel when a new ATTEST action lands. The raw action row
    // from getActionsSince doesn't carry the version, so we enrich it from the
    // consolidated `attests` table to tell a v0 request from a v1 response.
    async _emitAttestationEvents(coin, config, action) {
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
            // Non-fatal — attestation enrichment failure must not break the poll loop
        }
    }

    // Get current state (for WELCOME message)
    getState(coin) {
        return this.state[coin] || { blockIndex: 0, actionIndex: 0 };
    }
}

module.exports = ChangeDetector;
